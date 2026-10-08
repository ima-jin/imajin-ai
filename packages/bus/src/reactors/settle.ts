import { createLogger } from '@imajin/logger';
import { publish } from '../publish';
import type { ReactorHandler } from '../types';
import { computeFeeCents, resolveSettlementChain, type FairSettlementEntry } from '@imajin/fair';

const log = createLogger('bus:settle');

// #2642: settlement runs IN-PROCESS. The kernel (the only place `settlePayment()`
// and the pay ledger live) injects it at boot via `registerSettleExecutor()` —
// this package must not import `apps/kernel`. The reactor no longer makes an
// HTTP call to `/pay/api/settle` and no longer reads `PAY_SERVICE_URL` /
// `PAY_SERVICE_API_KEY`: the shared key is not accepted on that route any more.

/** The settlement request, in the kernel `settlePayment()` parameter vocabulary. */
export interface SettleExecutorParams {
  from_did: string;
  total_amount: number;
  service: string;
  type: string;
  fair_manifest: { chain: Array<{ did: string; amount: number; role: string }> };
  funded?: boolean;
  funded_provider?: string;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export type SettleExecutorResult =
  | { error: string; status: number }
  | { settled: true; batchId: string; transactions: string[]; total_amount: number; recipients: number; source: string };

export type SettleExecutor = (params: SettleExecutorParams) => Promise<SettleExecutorResult>;

// Held on `globalThis` (not a module-level `let`) because Next can bundle this
// package into more than one chunk of the same server process (instrumentation
// vs. route bundles); a per-module variable would register into one copy and be
// invisible to the copy the publisher's reactor actually runs in.
const EXECUTOR_KEY = Symbol.for('@imajin/bus:settle-executor');
type ExecutorHolder = { [EXECUTOR_KEY]?: SettleExecutor | null };

/** Register the in-process settlement executor (kernel boot). Pass `null` to clear it (tests). */
export function registerSettleExecutor(executor: SettleExecutor | null): void {
  (globalThis as ExecutorHolder)[EXECUTOR_KEY] = executor;
}

/** The registered in-process settlement executor, or `undefined` outside the kernel process. */
export function getSettleExecutor(): SettleExecutor | undefined {
  return (globalThis as ExecutorHolder)[EXECUTOR_KEY] ?? undefined;
}

interface FairFee {
  role: string;
  name: string;
  rateBps: number;
  fixedCents: number;
}

interface FairManifest {
  version?: string;
  fees?: FairFee[];
  chain?: FairSettlementEntry[];
  distributions?: FairSettlementEntry[];
  [key: string]: unknown;
}

interface SettlementParams {
  buyerDid: string | undefined;
  amountCents: number | undefined;
  currency: string | undefined;
  fairManifest: FairManifest | null | undefined;
  funded: boolean | undefined;
  funded_provider: string | undefined;
  metadata: Record<string, unknown> | undefined;
  orderId: string | undefined;
  eventId: string | undefined;
  service: string | undefined;
  type: string | undefined;
}

type ResolvedChain = Array<{ did: string; amount: number; role: string }>;

function extractSettlementParams(event: Parameters<ReactorHandler>[0]): SettlementParams {
  const payload = event.payload || {};
  const metadata = payload.metadata as Record<string, unknown> | undefined;

  return {
    buyerDid: (payload.buyerDid as string | undefined) || event.issuer,
    amountCents: payload.amount as number | undefined,
    currency: payload.currency as string | undefined,
    fairManifest: payload.fairManifest as FairManifest | null | undefined,
    funded: payload.funded as boolean | undefined,
    funded_provider: payload.funded_provider as string | undefined,
    metadata,
    orderId: (payload.orderId as string | undefined) || (metadata?.orderId as string | undefined),
    eventId: (payload.eventId as string | undefined) || (metadata?.eventId as string | undefined),
    service: (payload.settle_service as string | undefined) || event.scope,
    type: (payload.settle_type as string | undefined) || event.type,
  };
}

function resolveFairChain(
  fairManifest: FairManifest | null | undefined,
  buyerDid: string | undefined,
  amountCents: number,
  eventType: string
): { resolvedChain: ResolvedChain | undefined; expectedTotal: number | undefined } {
  const chain = fairManifest?.chain;
  if (!fairManifest || !chain?.length) {
    return { resolvedChain: undefined, expectedTotal: undefined };
  }

  const NODE_DID = process.env.NODE_DID || process.env.RELAY_IMAJIN_DID || null;
  if (!NODE_DID) {
    log.warn({ event: eventType }, '[settle] NODE_DID not set — node fee recipient unresolved');
  }

  const result = resolveSettlementChain({
    amountCents,
    chain,
    fees: fairManifest.fees,
    buyerDid: buyerDid ?? '',
    nodeDid: NODE_DID,
  });
  return { resolvedChain: result.resolvedChain, expectedTotal: result.expectedTotal };
}

function buildSettleRequestBody(
  params: SettlementParams,
  resolvedChain: ResolvedChain | undefined,
  expectedTotal: number | undefined
): Partial<SettleExecutorParams> {
  const { buyerDid, amountCents, currency, funded, funded_provider, metadata, service, type } = params;
  const body: Partial<SettleExecutorParams> = {
    from_did: buyerDid,
    total_amount: expectedTotal ?? (amountCents as number) / 100,
    service,
    type,
  };

  if (funded !== undefined) body.funded = funded;
  if (funded_provider) body.funded_provider = funded_provider;
  if (currency) body.currency = currency;
  if (resolvedChain) body.fair_manifest = { chain: resolvedChain };
  if (metadata) body.metadata = metadata;

  return body;
}

/** The request is only runnable when every field the settlement core needs is present (what the HTTP route's 400 used to enforce). */
function isCompleteSettleRequest(body: Partial<SettleExecutorParams>): body is SettleExecutorParams {
  return Boolean(body.from_did && body.total_amount && body.service && body.type && body.fair_manifest);
}

async function runSettlement(
  executor: SettleExecutor,
  body: Partial<SettleExecutorParams>,
  eventType: string,
  buyerDid: string | undefined,
  amountCents: number
): Promise<Extract<SettleExecutorResult, { settled: true }> | undefined> {
  if (!isCompleteSettleRequest(body)) {
    log.warn({ event: eventType }, 'Settlement skipped: from_did, total_amount, service, type or fair_manifest missing');
    return undefined;
  }

  try {
    const result = await executor(body);
    if ('error' in result) {
      log.error({ status: result.status, error: result.error }, 'Settlement request failed');
      return undefined;
    }

    log.info({ event: eventType, buyerDid, amount: amountCents, batchId: result.batchId }, 'Settlement complete');
    return result;
  } catch (err) {
    log.error({ err: String(err) }, 'Settlement request error');
    return undefined;
  }
}

function buildResolvedFees(fairManifest: FairManifest | null | undefined, amountCents: number) {
  return (fairManifest?.fees || []).map((fee) => ({
    role: fee.role,
    name: fee.name,
    rateBps: fee.rateBps,
    fixedCents: fee.fixedCents,
    amount: Number.parseFloat((computeFeeCents(amountCents, fee.rateBps, fee.fixedCents) / 100).toFixed(2)),
    estimated: true,
  }));
}

async function emitSettlementCompletedEvent(
  event: Parameters<ReactorHandler>[0],
  params: SettlementParams,
  amountCents: number,
  resolvedChain: ResolvedChain | undefined,
  expectedTotal: number | undefined
): Promise<void> {
  const { buyerDid, orderId, eventId, currency, metadata, fairManifest } = params;

  if (!orderId) {
    log.warn({ event: event.type }, 'Settlement completed but orderId is missing; skipping settlement.completed publish');
    return;
  }

  const resolvedFees = buildResolvedFees(fairManifest, amountCents);

  try {
    await publish('settlement.completed', {
      issuer: buyerDid || event.issuer,
      subject: event.subject,
      scope: event.scope,
      payload: {
        orderId,
        eventId: eventId || '',
        buyerDid: buyerDid || event.issuer,
        amount: amountCents,
        currency: currency || 'CAD',
        totalAmount: amountCents / 100,
        netAmount: expectedTotal ?? amountCents / 100,
        fees: resolvedFees,
        chain: resolvedChain || [],
        metadata,
      },
    });
    log.info({ event: event.type, buyerDid, amount: amountCents }, 'Settlement completed event emitted');
  } catch (publishErr) {
    log.error({ err: String(publishErr) }, 'Failed to emit settlement.completed (non-fatal)');
  }
}

export const settleReactor: ReactorHandler = async (event, _config) => {
  const executor = getSettleExecutor();
  if (!executor) {
    // Settlement only exists inside the kernel process. A publisher running in
    // another process (an app that imports @imajin/bus) has nothing to settle with.
    log.error({ event: event.type }, 'Settlement skipped: no in-process settle executor registered (settle runs in the kernel process only)');
    return;
  }

  const params = extractSettlementParams(event);
  const { amountCents } = params;

  if (!amountCents || typeof amountCents !== 'number') {
    log.warn({ event: event.type }, 'Settlement skipped: amount missing or invalid');
    return;
  }

  const { resolvedChain, expectedTotal } = resolveFairChain(params.fairManifest, params.buyerDid, amountCents, event.type);
  const body = buildSettleRequestBody(params, resolvedChain, expectedTotal);
  const result = await runSettlement(executor, body, event.type, params.buyerDid, amountCents);

  // Emit settlement.completed so downstream services can snapshot the receipt
  if (result) {
    await emitSettlementCompletedEvent(event, params, amountCents, resolvedChain, expectedTotal);
  }
};
