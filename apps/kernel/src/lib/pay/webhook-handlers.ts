/**
 * Stripe webhook handler helpers — kernel pay domain
 *
 * Extracted from apps/kernel/app/pay/api/webhook/route.ts to bring
 * handleCheckoutCompleted's cognitive complexity (S3776) below 15.
 *
 * Public surface (exported) is intentionally narrow — only the pieces
 * that are reused from the route or tested in isolation are exported.
 */

import { db, transactions } from '@/src/db';
import { externalRefColumns, whereExternalRef } from '@/src/lib/pay/external-ref';
import { generateId } from '@/src/lib/kernel/id';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { processorFeeCents } from '@imajin/fair';
import { fetchActualFee } from './providers/stripe-webhook';
import { verifySettlementSignature } from './settle-core';
import { MJN, MJNX, creditUnit } from './ledger';
import { applyFeeCredit } from './fee-credits';
import { publishFeeReceipt, type FeeReceiptContext } from './fee-receipts';
import { forEachSequential } from '@/src/lib/async/sequential';
import type { StripeCheckoutSessionLike } from './webhook-event-shapes';
import { kernelWebhookUrl, postKernelWebhook } from '@/src/lib/auth/kernel-webhook';
import type { LegacyWebhookApp } from '@/src/lib/auth/kernel-webhook-legacy';
import { resolveRegistryAppBaseUrl } from '@/src/lib/apps/registry-url';
import { checkoutAppSlug } from './checkout-notification-owner';

const log = createLogger('kernel');

/** Rail this webhook module serves — keys the `processorFee*` fee-schedule lookup (#2177). */
const WEBHOOK_RAIL = 'stripe';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** One `.fair` `taxes[]` row (#2419), cents-based — the subset the webhook needs to book the trust liability. */
export interface FairManifestTax {
  jurisdiction: string;
  kind: string;
  rateBps: number;
  /** Pre-tax subtotal the rate applies to (cents). */
  basisAmount: number;
  /** Tax collected (cents) — held in trust, never fee base. */
  amount: number;
  collectorDid: string;
  remitTo: string;
  registrationNumber: string;
}

export interface FairManifest {
  fees?: Array<{ role: string; name: string; rateBps: number; fixedCents: number }>;
  chain?: Array<{ did: string; role: string; share: number }>;
  taxes?: FairManifestTax[];
}

/** Σ`taxes[].amount` in cents. Zero for a manifest without `taxes[]` — fully backward compatible. */
export function sumTaxCents(taxes: FairManifestTax[] | undefined): number {
  return (taxes ?? []).reduce((sum, tax) => sum + tax.amount, 0);
}

/** Minimal shape of a kernel transaction row needed by these helpers. */
export interface TxRow {
  id: string;
  service?: string | null;
  feeContext?: FeeReceiptContext;
}

// ---------------------------------------------------------------------------
// Fee helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to retrieve the actual Stripe processing fee from the
 * balance_transaction attached to the checkout session's payment intent.
 * Returns `null` when the fee cannot be read (not yet settled, API error, etc.).
 *
 * #2175: the actual Stripe API call now lives behind
 * `providers/stripe-webhook.ts`'s `fetchActualFee(externalRef)` — this
 * function is just the checkout-session-shaped entry point kept for the
 * route's existing call site.
 */
export async function fetchActualStripeFee(
  session: StripeCheckoutSessionLike,
  transactionId: string,
): Promise<number | null> {
  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
  if (!paymentIntentId) return null;

  const fee = await fetchActualFee(paymentIntentId);
  if (fee !== null) {
    log.info({ transactionId, stripeFee: fee }, '[webhook] Actual Stripe fee from balance_transaction');
  }
  return fee;
}

/**
 * Calculate the estimated processing fee from the .fair manifest's processor
 * entry, falling back to this webhook's rail fee schedule (`processorFeeCents`,
 * #2177). Pure function — no side effects.
 */
export function calculateEstimatedFee(manifest: FairManifest, totalAmountCents: number): number {
  const feeEntry = manifest.fees?.find(f => f.role === 'processor');
  return feeEntry
    ? Math.round((totalAmountCents * feeEntry.rateBps) / 10000) + (feeEntry.fixedCents || 0)
    : processorFeeCents(WEBHOOK_RAIL, totalAmountCents);
}

// ---------------------------------------------------------------------------
// Fee reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileStripeFeeParams {
  tx: TxRow;
  manifest: FairManifest;
  /** Actual fee in cents as reported by Stripe. */
  actualFeeCents: number;
  /** Estimated fee in cents as calculated from the manifest. */
  estimatedFeeCents: number;
  currency: string;
}

/**
 * Reconcile the Stripe processing fee when the actual amount differs from the
 * estimate.  Writes a `processor_rebate` (over-collected) or
 * `processor_surcharge` (under-collected) fee-ledger row and adjusts the
 * seller's MJNx credit balance accordingly.
 *
 * Only call this function when `actualFeeCents !== estimatedFeeCents`.
 */
export async function reconcileStripeFee({
  tx,
  manifest,
  actualFeeCents,
  estimatedFeeCents,
  currency,
}: ReconcileStripeFeeParams): Promise<void> {
  const sellerEntry = manifest.chain?.find(e => e.role === 'seller');
  const sellerDid = sellerEntry?.did;
  if (!sellerDid || sellerDid === 'NODE_PLACEHOLDER') return;

  const diffCents = Math.abs(estimatedFeeCents - actualFeeCents);

  if (actualFeeCents < estimatedFeeCents) {
    await applyFeeRebate({ tx, sellerDid, diffCents, estimatedFeeCents, actualFeeCents, currency });
  } else {
    await applyFeeSurcharge({ tx, sellerDid, diffCents, estimatedFeeCents, actualFeeCents, currency });
  }
}

interface FeeAdjustmentParams {
  tx: TxRow;
  sellerDid: string;
  diffCents: number;
  estimatedFeeCents: number;
  actualFeeCents: number;
  currency: string;
}

async function applyFeeRebate({
  tx, sellerDid, diffCents, estimatedFeeCents, actualFeeCents, currency,
}: FeeAdjustmentParams): Promise<void> {
  const receipt = await publishFeeReceipt('fee.rebate', {
    transactionId: tx.id,
    recipientDid: sellerDid,
    sellerDid,
    role: 'processor_rebate',
    amountCents: diffCents,
    currency,
    status: 'accrued',
  }, tx.feeContext);

  // #2016: a processing-fee rebate credits MJNx (the emitted, in-platform
  // unit) — it is not a fresh fiat receipt.
  await applyFeeCredit({
    transactionId: tx.id, service: tx.service, role: 'processor_rebate',
    recipientDid: sellerDid, unit: MJNX, amountCents: receipt.amountCents, currency: receipt.currency,
  });

  log.info(
    { transactionId: tx.id, sellerDid, rebateCents: diffCents, estimatedFeeCents, actualFeeCents },
    '[webhook] Processing fee rebate → MJNx',
  );
}

async function applyFeeSurcharge({
  tx, sellerDid, diffCents, estimatedFeeCents, actualFeeCents, currency,
}: FeeAdjustmentParams): Promise<void> {
  const receipt = await publishFeeReceipt('fee.surcharge', {
    transactionId: tx.id,
    recipientDid: sellerDid,
    sellerDid,
    role: 'processor_surcharge',
    amountCents: diffCents,
    currency,
    status: 'accrued',
  }, tx.feeContext);

  // #2016: mirrors applyFeeRebate — the surcharge debits the same MJNx row.
  await applyFeeCredit({
    transactionId: tx.id, service: tx.service, role: 'processor_surcharge',
    recipientDid: sellerDid, unit: MJNX, amountCents: -receipt.amountCents, currency: receipt.currency,
  });

  log.info(
    { transactionId: tx.id, sellerDid, surchargeCents: diffCents, estimatedFeeCents, actualFeeCents },
    '[webhook] Processing fee surcharge → MJNx debit',
  );
}

// ---------------------------------------------------------------------------
// Manifest signature verification (non-blocking) — #1073
// ---------------------------------------------------------------------------

export interface VerifyWebhookManifestSignatureParams {
  fair_manifest: Record<string, unknown>;
  from_did: string;
  service: string;
}

/**
 * Non-blocking manifest-signature gate for the webhook's chain-distribution
 * path (#1073). Reuses `verifySettlementSignature` from the canonical
 * settlement core (`settle-core.ts`) so both paths verify identically, but
 * — unlike the canonical route, which rejects an invalid signature — this
 * NEVER blocks settlement: Stripe has already collected the money by the
 * time this runs, and this webhook previously performed no verification at
 * all. On an absent or invalid signature it emits
 * `settlement.manifest.unverified` so the gap is loud and durable instead
 * of silent (the one #1073 behavior delta on this path), then always lets
 * `processChainDistribution` proceed exactly as before.
 */
export async function verifyWebhookManifestSignature(params: VerifyWebhookManifestSignatureParams): Promise<void> {
  const { fair_manifest, from_did, service } = params;
  let reason: string | null = null;

  try {
    const result = await verifySettlementSignature({ fair_manifest, from_did, service });
    if ('error' in result) {
      reason = result.error;
    } else if (!result.signatureVerified) {
      reason = 'fair_manifest has no verifiable signature';
    }
  } catch (err) {
    reason = `signature verification threw: ${String(err)}`;
  }

  if (!reason) return;

  log.warn({ fromDid: from_did, service, reason }, '[webhook] Settlement manifest unverified — proceeding without blocking');
  await publish('settlement.manifest.unverified', {
    issuer: process.env.PLATFORM_DID || 'system',
    subject: from_did,
    scope: 'pay',
    payload: { from_did, service, reason, context_id: from_did, context_type: 'pay' },
  }).catch((err) => log.error({ err: String(err) }, 'settlement.manifest.unverified publish error'));
}

// ---------------------------------------------------------------------------
// Chain distribution
// ---------------------------------------------------------------------------

export interface ProcessChainDistributionParams {
  tx: TxRow;
  /** The full amount Stripe collected (cents) — tax included when `taxes` is supplied. */
  totalAmountCents: number;
  currency: string;
  buyerDid: string | null;
  chain: Array<{ did: string; role: string; share: number }>;
  /** The manifest's `taxes[]` (#2435). When present, chain shares are computed on `totalAmountCents - Σtaxes.amount` only. */
  taxes?: FairManifestTax[];
}

/**
 * Walk the .fair manifest chain and write a fee-ledger row, balance credit,
 * and daily rollup for every participant (node, scope, buyer_credit, etc.).
 *
 * #2435: tax is never fee base. When the manifest carries `taxes[]`, every
 * share (seller, node, platform, protocol, scope, buyer_credit) is computed
 * on the pre-tax basis — the Stripe total minus Σ`taxes[].amount` — and each
 * tax row is then booked as a trust-liability credit
 * (`recordTaxTrustLiabilities`). Without `taxes[]` the basis equals the
 * total, so this is byte-identical to the pre-#2435 behavior.
 */
export async function processChainDistribution({
  tx,
  totalAmountCents,
  currency,
  buyerDid,
  chain,
  taxes,
}: ProcessChainDistributionParams): Promise<void> {
  const basisCents = totalAmountCents - sumTaxCents(taxes);
  if (basisCents <= 0) {
    // Stripe collected no more than the claimed tax: there is nothing to
    // split, and distributing the (tax-only) total would skim tax. Fail
    // closed rather than write any ledger row.
    log.error(
      { transactionId: tx.id, totalAmountCents, taxCents: sumTaxCents(taxes) },
      '[webhook] Stripe total does not exceed manifest taxes[] — skipping chain distribution',
    );
    return;
  }

  // Sequential on purpose: ledger writes — each recipient's fee row, publish and
  // balance/rollup update land in chain order, and the first failure stops every
  // later recipient.
  await forEachSequential(chain, async (entry, chainIndex) => {
    const amountCents = Math.round(basisCents * entry.share);
    if (amountCents <= 0) return;

    const recipientDid =
      entry.did === 'BUYER_PLACEHOLDER' ? (buyerDid || 'unresolved') : entry.did;
    const isSeller = entry.role === 'seller';
    const isBuyerCredit = entry.role === 'buyer_credit';
    const status = isSeller ? 'paid_out' : 'accrued';

    const receipt = await publishFeeReceipt('fee.record', {
      transactionId: tx.id,
      recipientDid,
      role: entry.role,
      amountCents,
      currency,
      status,
      chainIndex,
    }, tx.feeContext);

    // Seller's payout goes directly to their Stripe — skip balance bookkeeping.
    if (recipientDid !== 'unresolved' && !isSeller) {
      await applyFeeCredit({
        transactionId: tx.id, service: tx.service, role: entry.role, recipientDid,
        unit: isBuyerCredit ? MJNX : MJN, amountCents: receipt.amountCents,
        currency: receipt.currency, chainIndex, rollup: true,
      });
    }
  });

  await recordTaxTrustLiabilities({ tx, taxes: taxes ?? [], currency, buyerDid });
}

interface RecordTaxTrustLiabilitiesParams {
  tx: TxRow;
  taxes: FairManifestTax[];
  currency: string;
  buyerDid: string | null;
}

/**
 * Book each `.fair` `taxes[]` row as a trust-liability credit (#2435),
 * mirroring what `settlePayment()`'s `creditTaxRows` records for the
 * canonical path:
 *  - a `feeLedger` row (`role: 'tax'`, status `held_in_trust`) — never
 *    `accrued`, since tax is not a fee anyone has earned; and
 *  - a `transactions` row tagged `{ tax, jurisdiction, kind, rateBps,
 *    remitTo, registrationNumber, trustLiability: true, remitted: null }`,
 *    the exact shape `getTaxRemittanceOwed` sums.
 * No internal balance is credited: this checkout is a Stripe destination
 * charge, so the tax money already sits in the collector's connected
 * account (`validateCheckoutBody` guarantees the collector is the seller).
 * The transactions row deliberately carries no `externalRef`, so the webhook's
 * by-session idempotency lookup can never match it. Zero-amount rows are
 * skipped, consistent with `taxLineItems` not sending them to Stripe.
 */
async function recordTaxTrustLiabilities({
  tx,
  taxes,
  currency,
  buyerDid,
}: RecordTaxTrustLiabilitiesParams): Promise<void> {
  await forEachSequential(taxes, async (tax, chainIndex) => {
    if (tax.amount <= 0) return;
    await publishFeeReceipt('fee.record', {
      transactionId: tx.id, recipientDid: tax.collectorDid, role: 'tax',
      amountCents: tax.amount, currency, status: 'held_in_trust', chainIndex,
      tax: {
        jurisdiction: tax.jurisdiction, kind: tax.kind, rateBps: tax.rateBps,
        remitTo: tax.remitTo, registrationNumber: tax.registrationNumber,
        service: tx.service || 'unknown', buyerDid,
      },
    }, tx.feeContext);
  });
}

// ---------------------------------------------------------------------------
// Top-up checkout
// ---------------------------------------------------------------------------

/**
 * Handle a top-up checkout session: insert a completed transaction and credit
 * the buyer's cash balance atomically.
 * Does nothing when the required metadata fields are absent.
 */
export async function handleTopupCheckout(session: StripeCheckoutSessionLike): Promise<void> {
  const topupAmountStr = session.metadata?.topupAmount;
  const buyerDid = session.metadata?.buyerDid;
  if (!topupAmountStr || !buyerDid) return;

  const topupAmount = Number.parseFloat(topupAmountStr);
  const currency = (session.currency || 'cad').toUpperCase();
  const txId = generateId('tx');

  await db.transaction(async (tx) => {
    await tx.insert(transactions).values({
      id: txId,
      service: 'topup',
      type: 'topup',
      fromDid: null,
      toDid: buyerDid,
      amount: topupAmount.toString(),
      currency,
      unit: MJN,
      sourceKind: 'receipt',
      status: 'completed',
      ...externalRefColumns(session.id),
      source: 'fiat',
      metadata: { ...session.metadata, checkoutSessionId: session.id },
    });

    await creditUnit(tx, buyerDid, MJN, topupAmount, { currency });
  });

  log.info(
    { service: 'pay', transactionId: txId, buyerDid, amount: topupAmount },
    'Top-up credited via webhook',
  );
}

// ---------------------------------------------------------------------------
// Service notifications
// ---------------------------------------------------------------------------

/**
 * Notify only the registered app that created this checkout. Caller metadata
 * may describe its purchase, but can never select another app's fulfillment.
 */
export async function notifyCheckoutServices(session: StripeCheckoutSessionLike): Promise<void> {
  const appSlug = await checkoutAppSlug(session);
  if (appSlug === 'events' && session.metadata?.eventId) {
    await notifyEventsService('checkout.completed', session);
  }

  if (appSlug === 'market' && session.metadata?.service === 'market') {
    if (session.metadata.sellerDid) {
      publishMarketNotifications(session);
    }
    // #2740: market settles its own purchases (registered-app contract), so it must be told
    // the session is paid. Awaited, but never throws — see notifyMarketService.
    await notifyMarketService(session);
  }

  if (appSlug === 'learn' && isLearnCheckout(session)) {
    // ima-jin/learn#13: learn creates the enrollment from this notification. Awaited, but never
    // throws — see notifyLearnService.
    await notifyLearnService(session);
  }
}

/**
 * A course-enrollment checkout started by the learn app. Learn tags its checkout `service: 'learn'`
 * like every other app; `source: 'learn'` is what it sent before it adopted that tag, so a checkout
 * started by that build and paid after this deploys is still recognised.
 */
function isLearnCheckout(session: StripeCheckoutSessionLike): boolean {
  return session.metadata?.service === 'learn' || session.metadata?.source === 'learn';
}

/** A downstream app the kernel tells, server-to-server, that its checkout was paid. */
interface PaidCheckoutTarget {
  /** Capitalised name used in log lines. */
  label: string;
  app: LegacyWebhookApp;
  /** What does not happen when the notification cannot be sent. */
  consequence: string;
}

const MARKET_TARGET: PaidCheckoutTarget = {
  label: 'Market',
  app: 'market',
  consequence: 'market purchase will not settle',
};

const LEARN_TARGET: PaidCheckoutTarget = {
  label: 'Learn',
  app: 'learn',
  consequence: 'learn enrollment will not be created',
};

/**
 * POST a signed `payment.succeeded` to the registered app's `/api/webhook`.
 * The payload names the Stripe `sessionId` and carries the
 * amount and currency in `metadata`; `rail` rides top-level and only when the kernel already
 * settled the payment on the seller's own Stripe account (#2773).
 *
 * Never throws: the payment is already collected, so an outage (or a 5xx) at the app is logged
 * and must not fail the Stripe webhook ack.
 */
async function deliverPaidCheckout(target: PaidCheckoutTarget, session: StripeCheckoutSessionLike): Promise<void> {

  try {
    const serviceUrl = await resolveRegistryAppBaseUrl(target.app);
    if (!serviceUrl) {
      log.error(
        { sessionId: session.id },
        `${target.label} registry URL unavailable — ${target.consequence}`,
      );
      return;
    }
    const response = await postKernelWebhook(kernelWebhookUrl(serviceUrl, '/api/webhook'), {
      type: 'payment.succeeded',
      sessionId: session.id,
      paymentId:
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id,
      // #2773: present only for a payment the kernel already settled on the seller's own Stripe account.
      ...(session.rail && { rail: session.rail }),
      // Kernel-attested seller (BYO only) — unlike `metadata.sellerDid`, the caller cannot choose it.
      ...(session.sellerDid && { sellerDid: session.sellerDid }),
      metadata: {
        ...session.metadata,
        amount: session.amount_total,
        currency: session.currency?.toUpperCase(),
      },
    }, target.app);

    if (response.ok) {
      log.info({ sessionId: session.id }, `${target.label} service notified successfully`);
    } else {
      const error = await response.text();
      log.error(
        { sessionId: session.id, status: response.status, error },
        `${target.label} service webhook failed`,
      );
    }
  } catch (error) {
    log.error(
      { sessionId: session.id, err: String(error) },
      `Failed to notify ${target.label.toLowerCase()} service`,
    );
    // Don't throw — the payment is still valid; the Stripe webhook ack must not fail over it.
  }
}

/**
 * Tell the market service a listing purchase was paid (#2740), so it can settle it through
 * its own app-service token on `POST /pay/api/settle`. Uses the same signed server-to-server
 * scheme as `notifyEventsService`. The payload names the Stripe `sessionId` — market
 * recorded the kernel payment it belongs to when the buyer started checkout — and carries
 * the amount and currency market's webhook reads from `metadata`.
 *
 * Never throws: the payment is already collected, so a market outage (or a 5xx from it) is
 * logged and must not fail the Stripe webhook ack.
 */
export async function notifyMarketService(session: StripeCheckoutSessionLike): Promise<void> {
  await deliverPaidCheckout(MARKET_TARGET, session);
}

/**
 * Tell the learn app a course-enrollment checkout was paid (ima-jin/learn#13), so it can create
 * the enrollment. Learn verifies the kernel signature and keys the enrollment off
 * `metadata.courseId` / `metadata.studentDid`. The
 * payload is the market one: `sessionId`, `paymentId`, a top-level `rail` for a BYO-settled
 * payment, and the amount and currency in `metadata`.
 *
 * Never throws: the payment is already collected, so a learn outage (or a 5xx from it) is logged
 * and must not fail the Stripe webhook ack. Redelivery is safe — learn's enrollment is idempotent.
 */
export async function notifyLearnService(session: StripeCheckoutSessionLike): Promise<void> {
  await deliverPaidCheckout(LEARN_TARGET, session);
}

function publishMarketNotifications(session: StripeCheckoutSessionLike): void {
  const sellerDid = session.metadata!.sellerDid;
  const buyerDid = session.metadata?.buyerDid;
  const listingTitle = session.metadata?.listingTitle;
  const amount = session.amount_total ?? 0;
  const currency = (session.currency ?? 'usd').toUpperCase();
  const buyerEmail = session.customer_email || session.customer_details?.email || undefined;
  const buyerName = session.customer_details?.name || undefined;

  publish('market.sale', {
    issuer: process.env.PLATFORM_DID || 'system',
    subject: sellerDid,
    scope: 'market',
    payload: { listingTitle, amount, currency, ...(buyerName && { buyerName }) },
  }).catch((err) => log.error({ err: String(err) }, 'Notify market:sale error'));

  if (buyerDid) {
    publish('market.purchase', {
      issuer: process.env.PLATFORM_DID || 'system',
      subject: buyerDid,
      scope: 'market',
      payload: { ...(buyerEmail && { email: buyerEmail }), listingTitle, amount, currency },
    }).catch((err) => log.error({ err: String(err) }, 'Notify market:purchase error'));
  }
}

/**
 * The kernel `pay.transactions` id the checkout session belongs to (#2739). Events settles through
 * `POST /pay/api/settle`, which is keyed by this id, not by the Stripe session id the webhook is
 * otherwise named by.
 *
 * Fails soft: no row (or a lookup error) yields `undefined` and a log line, never a throw — the
 * payment is already collected and the webhook notification must still go out.
 */
export async function findTransactionIdForSession(sessionId: string): Promise<string | undefined> {
  try {
    const [row] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(whereExternalRef(sessionId))
      .limit(1);
    if (row?.id) return row.id;
    log.error({ sessionId }, 'No pay.transactions row for checkout session — events webhook will carry no transactionId');
  } catch (error) {
    log.error(
      { sessionId, err: String(error) },
      'pay.transactions lookup failed — events webhook will carry no transactionId',
    );
  }
  return undefined;
}

export async function notifyEventsService(
  type: 'checkout.completed' | 'payment.failed',
  session: StripeCheckoutSessionLike,
): Promise<void> {

  try {
    const eventsServiceUrl = await resolveRegistryAppBaseUrl('events');
    if (!eventsServiceUrl) {
      log.error({}, 'Events registry URL unavailable — events payment notification cannot be delivered');
      return;
    }
    const transactionId = type === 'checkout.completed'
      ? (session.transactionId ?? await findTransactionIdForSession(session.id))
      : undefined;
    const response = await postKernelWebhook(kernelWebhookUrl(eventsServiceUrl, '/api/webhook/payment'), {
      type,
      sessionId: session.id,
      ...(transactionId && { transactionId }),
      // #2773: present only for a payment the kernel already settled on the seller's own Stripe account.
      ...(session.rail && { rail: session.rail }),
      // Kernel-attested seller (BYO only) — unlike `metadata.sellerDid`, the caller cannot choose it.
      ...(session.sellerDid && { sellerDid: session.sellerDid }),
      paymentId:
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id,
      customerEmail: session.customer_email || session.customer_details?.email || null,
      customerName: session.customer_details?.name || null,
      amountTotal: session.amount_total,
      currency: session.currency,
      metadata: session.metadata,
    }, 'events');

    if (response.ok) {
      log.info({}, 'Events service notified successfully');
    } else {
      const error = await response.text();
      log.error({ error }, 'Events service webhook failed');
    }
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to notify events service');
    // Don't throw — the payment is still valid; fulfillment is handled separately.
  }
}
