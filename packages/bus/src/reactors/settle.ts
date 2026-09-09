import { createLogger } from '@imajin/logger';
import { publish } from '../publish';
import type { ReactorHandler } from '../types';
import { computeFeeCents, resolveSettlementChain } from '@imajin/fair';

const log = createLogger('bus:settle');

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL;
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY;

interface FairEntry {
  did: string;
  role: string;
  share: number;
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
  chain?: FairEntry[];
  distributions?: FairEntry[];
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

interface SettleServiceResult {
  settled: boolean;
  batchId: string;
  transactions: string[];
  total_amount: number;
  recipients: number;
  source: string;
}

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
): Record<string, unknown> {
  const { buyerDid, amountCents, currency, funded, funded_provider, metadata, service, type } = params;
  const body: Record<string, unknown> = {
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

async function callSettleService(
  body: Record<string, unknown>,
  eventType: string,
  buyerDid: string | undefined,
  amountCents: number
): Promise<SettleServiceResult | undefined> {
  try {
    const response = await fetch(`${PAY_SERVICE_URL}/api/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PAY_SERVICE_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      log.error({ status: response.status, text }, 'Settlement request failed');
      return undefined;
    }

    const result = await response.json() as SettleServiceResult;
    log.info({ event: eventType, buyerDid, amount: amountCents, batchId: result?.batchId }, 'Settlement complete');
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
  if (!PAY_SERVICE_URL || !PAY_SERVICE_API_KEY) {
    log.warn({}, 'Settlement skipped: PAY_SERVICE_URL or PAY_SERVICE_API_KEY not set');
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
  const result = await callSettleService(body, event.type, params.buyerDid, amountCents);

  // Emit settlement.completed so downstream services can snapshot the receipt
  if (result?.settled) {
    await emitSettlementCompletedEvent(event, params, amountCents, resolvedChain, expectedTotal);
  }
};
