import { db, transactions } from '@/src/db';
import { and, eq, or, sql } from 'drizzle-orm';
import { externalRefColumns, whereExternalRef } from '@/src/lib/pay/external-ref';
import { generateId } from '@/src/lib/kernel/id';
import { forEachSequential } from '@/src/lib/async/sequential';
import type { Logger } from '@imajin/logger';
import { sellerPledgeRefundClient, sellerSessionPaymentIntent } from './providers/seller-pledge-refund';
import { resolveDidStripeKeys } from './rails/stripe-keys';
import { STRIPE_BYO_RAIL } from './external-ref';
import { MJN, creditUnit, debitUnit } from './ledger';

type LoggerLike = Pick<Logger, 'error'>;
type TransactionRow = typeof transactions.$inferSelect;
function isSellerSession(row: TransactionRow): row is TransactionRow & { toDid: string; externalRef: string } {
  return row.rail === STRIPE_BYO_RAIL && Boolean(row.toDid) && Boolean(row.externalRef?.startsWith('cs_'));
}

/**
 * Resolve persisted references first. Intent-only callers may inspect ONLY
 * the authenticated app's recorded seller-account sessions, never platform Stripe.
 */
export async function resolveOriginalTransaction(
  paymentId: string,
  log: LoggerLike,
  appDid: string,
): Promise<TransactionRow | undefined> {
  const [directMatch] = await db
    .select()
    .from(transactions)
    .where(or(whereExternalRef(paymentId), whereExternalRef(paymentId, STRIPE_BYO_RAIL)))
    .limit(1);
  if (directMatch) return directMatch;

  if (paymentId.startsWith('pi_')) {
    const candidates = await db.select().from(transactions).where(eq(transactions.appDid, appDid));
    for (const row of candidates) {
      const metadata = row.metadata as Record<string, unknown> | null;
      if (metadata?.paymentIntentId === paymentId || metadata?.stripePaymentIntentId === paymentId) return row;
    }
    for (const row of candidates) {
      if (!isSellerSession(row)) continue;
      const { secretKey } = await resolveDidStripeKeys(row.toDid);
      try {
        if (await sellerSessionPaymentIntent(secretKey, row.externalRef) === paymentId) return row;
      } catch {
        log.error({ transactionId: row.id }, '[refund] Seller session lookup unavailable');
      }
    }
  }
  return undefined;
}

/** Only the account that took the original payment may refund it. */
export async function refundSellerPayment(originalTx: TransactionRow, amount: number) {
  if (originalTx.rail !== STRIPE_BYO_RAIL || !originalTx.toDid) throw new Error('LEGACY_PLATFORM_PAYMENT');
  const { secretKey } = await resolveDidStripeKeys(originalTx.toDid);
  const metadata = originalTx.metadata as Record<string, unknown> | null;
  const recorded = metadata?.paymentIntentId ?? metadata?.stripePaymentIntentId;
  const paymentIntentId = originalTx.externalRef?.startsWith('pi_')
    ? originalTx.externalRef
    : typeof recorded === 'string' && recorded.startsWith('pi_')
      ? recorded
      : originalTx.externalRef?.startsWith('cs_')
        ? await sellerSessionPaymentIntent(secretKey, originalTx.externalRef)
        : undefined;
  if (!paymentIntentId) throw new Error('Original seller payment intent is unavailable');
  const refund = await sellerPledgeRefundClient(secretKey).refunds.create({ payment_intent: paymentIntentId, amount });
  return { id: refund.id, paymentId: originalTx.externalRef!, amount: refund.amount, status: refund.status };
}

export type RefundEligibility =
  | { ok: true; txAmountDollars: number; requestedRefundDollars: number; totalRefundedDollars: number }
  | { ok: false; error: string; status: number };

/**
 * Check whether a refund can proceed against the original transaction:
 * rejects already-fully-refunded transactions, and rejects a request that
 * (combined with any prior partial refunds) would exceed the original
 * amount. Returns the dollar figures needed for the ledger update on success.
 */
export async function checkRefundEligibility(
  originalTx: TransactionRow,
  amount: number | undefined,
): Promise<RefundEligibility> {
  if (originalTx.status === 'refunded') {
    return { ok: false, error: 'Transaction already fully refunded', status: 400 };
  }

  if (amount !== undefined && (!Number.isSafeInteger(amount) || amount <= 0)) {
    return { ok: false, error: 'amount must be a positive integer in cents', status: 400 };
  }
  if (!['completed', 'partially_refunded'].includes(originalTx.status)) {
    return { ok: false, error: 'Only completed payments can be refunded', status: 409 };
  }
  const txAmountDollars = Number.parseFloat(originalTx.amount);

  // For partially-refunded txs, sum all existing refund entries and verify
  // the new request doesn't exceed the remaining balance.
  const existingRefundTxs = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.type, 'refund'),
        sql`${transactions.metadata}->>'originalTxId' = ${originalTx.id}`,
      ),
    );
  const totalRefundedDollars = existingRefundTxs.reduce((sum, r) => sum + Number.parseFloat(r.amount), 0);
  const requestedRefundDollars = amount === undefined ? txAmountDollars - totalRefundedDollars : amount / 100;

  if (totalRefundedDollars + requestedRefundDollars > txAmountDollars + 0.005) {
    return { ok: false, error: 'Refund would exceed original transaction amount', status: 400 };
  }

  return { ok: true, txAmountDollars, requestedRefundDollars, totalRefundedDollars };
}

/**
 * Adjust MJN balances for a refund: debit the recipient, credit the payer.
 * Refunds only ever move MJN (the receipt-backed unit) — #2016 does not
 * change the pre-existing gap that a refund never claws back the MJNx
 * emitted on the original sale (see the #2012 audit).
 */
async function adjustBalancesForRefund(
  toDid: string | null,
  fromDid: string | null,
  refundedDollars: number,
  currency: string,
): Promise<void> {
  if (toDid) {
    await debitUnit(db, toDid, MJN, refundedDollars, { clampAtZero: true });
  }

  if (fromDid) {
    await creditUnit(db, fromDid, MJN, refundedDollars, { currency });
  }
}

export interface RefundLedgerResult {
  reversalId: string;
  isFullRefund: boolean;
}

/**
 * Mark the original transaction refunded/partially-refunded, create the
 * reversal transaction entry, and adjust cash balances accordingly.
 */
export async function applyRefundLedgerUpdates(params: {
  originalTx: TransactionRow;
  paymentId: string;
  refundStripeId: string;
  refundedDollars: number;
  totalRefundedDollars: number;
  txAmountDollars: number;
  reason?: string;
}): Promise<RefundLedgerResult> {
  const { originalTx, paymentId, refundStripeId, refundedDollars, totalRefundedDollars, txAmountDollars, reason } = params;

  const newTotalRefunded = totalRefundedDollars + refundedDollars;
  const isFullRefund = newTotalRefunded >= txAmountDollars - 0.005;
  const newTxStatus = isFullRefund ? 'refunded' : 'partially_refunded';

  await db.update(transactions).set({ status: newTxStatus }).where(eq(transactions.id, originalTx.id));

  const reversalId = generateId('tx');
  await db.insert(transactions).values({
    id: reversalId,
    appDid: originalTx.appDid,
    service: originalTx.service,
    type: 'refund',
    fromDid: originalTx.toDid,
    toDid: originalTx.fromDid ?? 'unknown',
    amount: refundedDollars.toString(),
    currency: originalTx.currency,
    unit: MJN,
    sourceKind: 'receipt',
    status: 'completed',
    source: 'fiat',
    ...externalRefColumns(refundStripeId, originalTx.rail ?? undefined),
    metadata: {
      originalTxId: originalTx.id,
      originalStripeId: paymentId,
      ...(reason && { reason }),
    },
  });

  if (originalTx.rail !== STRIPE_BYO_RAIL) {
    await adjustBalancesForRefund(originalTx.toDid, originalTx.fromDid, refundedDollars, originalTx.currency);
  }

  return { reversalId, isFullRefund };
}

/**
 * Reverse settlement entries (host share + platform fee) linked to the
 * checkout transaction. Settlement transactions link back via
 * `metadata.stripeSessionId` matching the checkout's `externalRef`. Each entry
 * is wound back proportionally by `requestedRefundDollars / txAmountDollars`
 * so that N per-ticket refunds each reclaim their fair share without
 * over-reversing.
 */
export async function reverseSettlementEntries(params: {
  originalTx: TransactionRow;
  requestedRefundDollars: number;
  txAmountDollars: number;
  isFullRefund: boolean;
  reason?: string;
}): Promise<void> {
  const { originalTx, requestedRefundDollars, txAmountDollars, isFullRefund, reason } = params;
  if (originalTx.rail === STRIPE_BYO_RAIL) return;
  const checkoutStripeId = originalTx.externalRef;
  if (!checkoutStripeId) return;

  const settlementTxs = await db
    .select()
    .from(transactions)
    .where(sql`${transactions.metadata}->>'stripeSessionId' = ${checkoutStripeId}`);

  const refundFraction = requestedRefundDollars / txAmountDollars;
  const newSettlementStatus = isFullRefund ? 'refunded' : 'partially_refunded';

  // Sequential on purpose: ledger writes — each settlement row's status flip,
  // reversal insert and balance debit land in order, and the first failure stops
  // every later reversal.
  await forEachSequential(settlementTxs, async (stx) => {
    if (stx.status === 'refunded') return;

    const stxAmount = Number.parseFloat(stx.amount);
    // Proportional reversal amount, rounded to 8 decimal places.
    const stxReversalAmount = Math.round(stxAmount * refundFraction * 1e8) / 1e8;
    if (stxReversalAmount <= 0) return;

    await db.update(transactions).set({ status: newSettlementStatus }).where(eq(transactions.id, stx.id));

    const stxReversalId = generateId('tx');
    await db.insert(transactions).values({
      id: stxReversalId,
      service: stx.service,
      type: 'refund',
      fromDid: stx.toDid,
      toDid: stx.fromDid ?? 'unknown',
      amount: stxReversalAmount.toString(),
      currency: stx.currency,
      unit: MJN,
      sourceKind: 'receipt',
      status: 'completed',
      source: 'fiat',
      batchId: stx.batchId,
      metadata: {
        originalTxId: stx.id,
        refundOfSettlement: true,
        ...(reason && { reason }),
      },
    });

    if (stx.toDid) {
      await debitUnit(db, stx.toDid, MJN, stxReversalAmount, { clampAtZero: true });
    }
  });
}
