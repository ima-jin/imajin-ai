/**
 * Events' side of the registered-app pay contract (#2739, kernel: #2642/#2695).
 *
 *   1. CHECKOUT — events authenticates its pay `/api/checkout` call with its own
 *      app-service token and declares the `payeeManifest` (the resolved .fair
 *      chain it will settle against). The kernel binds the payment to events'
 *      app DID and records that manifest.
 *   2. SETTLE — once the buyer has paid (the pay webhook → `order.completed`
 *      moment), events calls `POST /pay/api/settle` itself with the same app
 *      token, the checkout's `transaction_id` and the `fair_manifest`. The
 *      kernel verifies ownership, the rail's confirmation and that the posted
 *      chain equals the recorded payee manifest, then settles. A replay of an
 *      already-settled payment returns `alreadySettled: true`, which is success.
 *
 * This replaces the bus `settle` reactor for events: that reactor only runs
 * where an in-process settle executor is registered (the kernel process), and
 * events publishes from its own process. No shared `PAY_SERVICE_API_KEY`.
 *
 * Correlation. `/pay/api/settle` is keyed by the kernel `transactionId` the app-authenticated
 * checkout returned; the pay webhook that notifies events (`checkout.completed`) must carry it
 * as `transactionId`. Events deliberately does NOT read the pay ledger tables to find it (a
 * cross-schema contract violation, see `ci-guard-cross-schema-reads`) — without it settlement is
 * skipped and logged loudly (see `settleOrderViaPay`).
 *
 * Chain amounts. The kernel settles an app payment for the recorded gross
 * amount, so the chain must sum to the payment total. The chain is therefore
 * resolved with NO processor-fee deduction (a zero-rate `processor` fee entry);
 * the old reactor's net-of-fee chain would be refused (400) by the kernel.
 */
import { publish } from '@imajin/bus';
import { computeFeeCents, resolveSettlementChain, type FairSettlementEntry } from '@imajin/fair';
import type { Logger } from '@imajin/logger';
import { getPayAppToken, invalidatePayAppToken } from './pay-app-token';

const BUYER_PLACEHOLDER = 'BUYER_PLACEHOLDER';

/** Zero-rate processor fee: resolve the chain against the GROSS payment total (see module docs). */
const NO_PROCESSOR_FEE = [{ role: 'processor', rateBps: 0, fixedCents: 0 }];

export interface PayeeChainEntry {
  did: string;
  role: string;
  /** Dollars. */
  amount: number;
}

/** The manifest shape the pay service records at checkout and verifies at settle. */
export interface PayeeManifest {
  chain: PayeeChainEntry[];
}

interface FairFee {
  role: string;
  name: string;
  rateBps: number;
  fixedCents: number;
}

interface EventFairManifest {
  fees?: FairFee[];
  chain?: FairSettlementEntry[];
}

function extractChain(fairManifest: unknown): FairSettlementEntry[] | null {
  const chain = (fairManifest as EventFairManifest | null | undefined)?.chain;
  return Array.isArray(chain) && chain.length > 0 ? chain : null;
}

/** True when the manifest has a `.fair` chain events can settle. */
export function hasSettleableChain(fairManifest: unknown): boolean {
  return extractChain(fairManifest) !== null;
}

/** True when the chain pays the buyer (`BUYER_PLACEHOLDER`), so a buyer DID must be known at checkout. */
export function chainNeedsBuyerDid(fairManifest: unknown): boolean {
  return extractChain(fairManifest)?.some((entry) => entry.did === BUYER_PLACEHOLDER) ?? false;
}

function nodeDid(): string | null {
  return process.env.NODE_DID || process.env.RELAY_IMAJIN_DID || null;
}

/**
 * Resolve an event's `.fair` manifest to the payee manifest declared at checkout:
 * share-based chain → absolute dollar amounts summing to the payment total,
 * placeholder DIDs substituted. `null` when the manifest has no chain.
 */
export function buildPayeeManifest(params: {
  fairManifest: unknown;
  amountCents: number;
  buyerDid?: string;
}): PayeeManifest | null {
  const chain = extractChain(params.fairManifest);
  if (!chain) return null;

  const { resolvedChain } = resolveSettlementChain({
    amountCents: params.amountCents,
    chain,
    fees: NO_PROCESSOR_FEE,
    buyerDid: params.buyerDid ?? '',
    nodeDid: nodeDid(),
  });
  return { chain: resolvedChain };
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/** What an app-authenticated pay checkout carries: the app token and the declared payee manifest. */
export interface AppCheckoutAuth {
  bearer: string;
  payeeManifest: PayeeManifest;
}

export type PrepareAppCheckoutResult = { appAuth: AppCheckoutAuth | null } | { error: string; status: number };

export interface PrepareAppCheckoutParams {
  fairManifest: unknown;
  /** Gross checkout total in cents. */
  amountCents: number;
  /** Hard-session buyer DID, when the buyer is signed in. */
  buyerDid?: string;
  email?: string;
  /** Resolve (or create) a soft DID for an email-only buyer — only called when the chain pays the buyer. */
  resolveSoftDid: (email: string) => Promise<string>;
  log: Logger;
}

async function resolveChainBuyerDid(params: PrepareAppCheckoutParams): Promise<string | { error: string; status: number }> {
  if (params.buyerDid) return params.buyerDid;
  if (!params.email) {
    return { error: 'An email address is required to check out for this event', status: 400 };
  }
  try {
    return await params.resolveSoftDid(params.email);
  } catch (err) {
    params.log.error({ err: String(err) }, 'Could not resolve buyer DID for the .fair chain');
    return { error: 'Checkout failed', status: 500 };
  }
}

/**
 * Prepare an app-authenticated pay checkout: mint events' app-service token and
 * resolve the payee manifest to declare. Returns `{ appAuth: null }` when the
 * event has no `.fair` chain (nothing to settle — checkout proceeds unbound, as
 * before) and `{ error, status }` when the checkout cannot be made settleable
 * (fail closed: taking a payment that can never pay the organizer is worse).
 */
export async function prepareAppCheckout(params: PrepareAppCheckoutParams): Promise<PrepareAppCheckoutResult> {
  const { log } = params;
  if (!hasSettleableChain(params.fairManifest)) {
    log.warn({}, '[settle] Event has no .fair chain — checkout is not app-bound and will not settle');
    return { appAuth: null };
  }

  let chainBuyerDid = params.buyerDid;
  if (chainNeedsBuyerDid(params.fairManifest)) {
    const resolved = await resolveChainBuyerDid(params);
    if (typeof resolved !== 'string') return resolved;
    chainBuyerDid = resolved;
  }

  const payeeManifest = buildPayeeManifest({
    fairManifest: params.fairManifest,
    amountCents: params.amountCents,
    buyerDid: chainBuyerDid,
  });
  if (!payeeManifest) return { appAuth: null };

  try {
    return { appAuth: { bearer: await getPayAppToken(), payeeManifest } };
  } catch (err) {
    log.error({ err: String(err) }, '[settle] Could not obtain events app-service token for checkout');
    return { error: 'Payment service unavailable', status: 503 };
  }
}

// ---------------------------------------------------------------------------
// Settle
// ---------------------------------------------------------------------------

export type SettleOutcome =
  | { status: 'settled'; alreadySettled: boolean; batchId?: string; manifest: PayeeManifest }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string; httpStatus?: number };

interface SettleCallParams {
  transactionId: string;
  manifest: PayeeManifest;
  metadata: Record<string, unknown>;
}

type SettleCallResult = { ok: true; alreadySettled: boolean; batchId?: string } | { ok: false; httpStatus?: number; error: string };

async function callPaySettle(params: SettleCallParams, retryOnUnauthorized: boolean): Promise<SettleCallResult> {
  const payServiceUrl = process.env.PAY_SERVICE_URL;
  if (!payServiceUrl) return { ok: false, error: 'PAY_SERVICE_URL is not set' };

  let token: string;
  try {
    token = await getPayAppToken();
  } catch (err) {
    return { ok: false, error: `app-service token unavailable: ${String(err)}` };
  }

  let res: Response;
  try {
    res = await fetch(`${payServiceUrl}/api/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        transaction_id: params.transactionId,
        fair_manifest: params.manifest,
        metadata: params.metadata,
      }),
    });
  } catch (err) {
    return { ok: false, error: `pay service unreachable: ${String(err)}` };
  }

  if (res.status === 401 && retryOnUnauthorized) {
    // Token expired or was revoked between mint and use — mint a fresh one, once.
    await invalidatePayAppToken().catch(() => undefined);
    return callPaySettle(params, false);
  }

  const body = (await res.json().catch(() => null)) as { error?: unknown; alreadySettled?: unknown; batchId?: unknown } | null;
  if (!res.ok) {
    return { ok: false, httpStatus: res.status, error: typeof body?.error === 'string' ? body.error : `status ${res.status}` };
  }
  return {
    ok: true,
    alreadySettled: body?.alreadySettled === true,
    batchId: typeof body?.batchId === 'string' ? body.batchId : undefined,
  };
}

export interface SettleOrderParams {
  /**
   * The kernel `transactionId` the app-authenticated checkout returned, as carried on the pay
   * webhook. Absent when the webhook does not send it — settlement is then skipped.
   */
  transactionId?: string;
  /** Stripe checkout session id the pay webhook reported (log correlation only). */
  sessionId: string;
  /** The event's `.fair` manifest — the chain is re-resolved exactly as it was declared at checkout. */
  fairManifest: unknown;
  /** The ticket owner DID — the buyer the checkout resolved for `BUYER_PLACEHOLDER`. */
  buyerDid: string;
  /** Gross payment total in cents. */
  amountCents: number;
  metadata: Record<string, unknown>;
  log: Logger;
}

/**
 * Settle a completed event order through `POST /pay/api/settle` with events'
 * own app-service token. Never throws: every non-success is a logged outcome
 * (the order and tickets already exist; settlement failure is non-fatal).
 */
export async function settleOrderViaPay(params: SettleOrderParams): Promise<SettleOutcome> {
  const { transactionId, sessionId, log } = params;

  if (!transactionId) {
    // Money was taken but cannot be settled by events — make that impossible to miss in the logs.
    log.error({ sessionId }, '[settle] Pay webhook carried no transactionId — order NOT settled');
    return { status: 'skipped', reason: 'pay webhook carried no transactionId' };
  }

  const manifest = buildPayeeManifest({
    fairManifest: params.fairManifest,
    amountCents: params.amountCents,
    buyerDid: params.buyerDid,
  });
  if (!manifest) {
    log.warn({ sessionId, transactionId }, '[settle] Event has no .fair chain — nothing to settle');
    return { status: 'skipped', reason: 'event has no .fair chain' };
  }

  const result = await callPaySettle({ transactionId, manifest, metadata: params.metadata }, true);
  if (!result.ok) {
    log.error({ sessionId, transactionId, status: result.httpStatus, error: result.error }, '[settle] pay /api/settle failed');
    return { status: 'failed', error: result.error, httpStatus: result.httpStatus };
  }

  log.info(
    { sessionId, transactionId, batchId: result.batchId, alreadySettled: result.alreadySettled },
    '[settle] Settlement complete',
  );
  return { status: 'settled', alreadySettled: result.alreadySettled, batchId: result.batchId, manifest };
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

export interface SettlementReceiptParams {
  orderId: string;
  eventId: string;
  buyerDid: string;
  /** The event's creator — the bus event subject. */
  creatorDid: string;
  amountCents: number;
  currency: string;
  fairManifest: unknown;
  metadata: Record<string, unknown>;
  manifest: PayeeManifest;
}

export interface SettleCompletedOrderParams extends Omit<SettlementReceiptParams, 'manifest'> {
  /** The kernel `transactionId` carried on the pay webhook (see `SettleOrderParams.transactionId`). */
  transactionId?: string;
  /** Stripe checkout session id the pay webhook reported. */
  sessionId: string;
  log: Logger;
}

/**
 * The `order.completed` moment for an event order: settle it through the pay
 * service with events' own app token, and on success (including an idempotent
 * `alreadySettled` replay) announce the settlement receipt. Never throws.
 */
export async function settleCompletedOrder(params: SettleCompletedOrderParams): Promise<SettleOutcome> {
  const { transactionId, sessionId, log, ...receipt } = params;
  const outcome = await settleOrderViaPay({
    transactionId,
    sessionId,
    fairManifest: receipt.fairManifest,
    buyerDid: receipt.buyerDid,
    amountCents: receipt.amountCents,
    metadata: receipt.metadata,
    log,
  });
  if (outcome.status === 'settled') {
    await publishSettlementReceipt({ ...receipt, manifest: outcome.manifest }, log);
  }
  return outcome;
}

/**
 * Announce `settlement.completed` (what the bus `settle` reactor used to emit)
 * so downstream consumers — including events' own `/api/webhook/settlement`
 * receipt snapshot — keep working. Non-fatal.
 */
export async function publishSettlementReceipt(params: SettlementReceiptParams, log: Logger): Promise<void> {
  const fees = ((params.fairManifest as EventFairManifest | null | undefined)?.fees ?? []).map((fee) => ({
    role: fee.role,
    name: fee.name,
    rateBps: fee.rateBps,
    fixedCents: fee.fixedCents,
    amount: Number.parseFloat((computeFeeCents(params.amountCents, fee.rateBps, fee.fixedCents) / 100).toFixed(2)),
    estimated: true,
  }));
  const settledTotal = Number.parseFloat(params.manifest.chain.reduce((sum, entry) => sum + entry.amount, 0).toFixed(2));

  try {
    await publish('settlement.completed', {
      issuer: params.buyerDid,
      subject: params.creatorDid,
      scope: 'events',
      payload: {
        orderId: params.orderId,
        eventId: params.eventId,
        buyerDid: params.buyerDid,
        amount: params.amountCents,
        currency: params.currency,
        totalAmount: params.amountCents / 100,
        netAmount: settledTotal,
        fees,
        chain: params.manifest.chain,
        metadata: params.metadata,
      },
    });
  } catch (err) {
    log.error({ err: String(err), orderId: params.orderId }, '[settle] Failed to publish settlement.completed (non-fatal)');
  }
}
