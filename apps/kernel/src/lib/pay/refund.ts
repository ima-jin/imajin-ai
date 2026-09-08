import { db, transactions, balances } from '@/src/db';
import { and, eq, sql } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import type { Logger } from '@imajin/logger';

type LoggerLike = Pick<Logger, 'error'>;
type TransactionRow = typeof transactions.$inferSelect;

/**
 * Resolve a Stripe checkout session ID (cs_xxx) to its transaction row via
 * the Stripe API, for callers (e.g. events tickets) that only know the
 * payment intent ID (pi_xxx). Non-fatal: logs and returns undefined on any
 * failure so the caller can fall back to a 404.
 */
async function resolveTransactionViaPaymentIntent(
  paymentId: string,
  log: LoggerLike,
): Promise<TransactionRow | undefined> {
  try {
    const Stripe = (await import('stripe')).default;
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY not configured');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' as any });
    const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentId, limit: 1 });
    if (!sessions.data[0]) return undefined;

    const [result] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.stripeId, sessions.data[0].id))
      .limit(1);
    return result;
  } catch (e) {
    log.error({ err: String(e) }, '[refund] Failed to resolve payment intent to session');
    return undefined;
  }
}

/**
 * Find the original transaction for a refund request. Pay stores the
 * checkout session ID (cs_xxx) as `stripeId`, but events tickets store the
 * payment intent ID (pi_xxx) — try `stripeId` first, then fall back to
 * resolving the payment intent to its session via the Stripe API.
 */
export async function resolveOriginalTransaction(
  paymentId: string,
  log: LoggerLike,
): Promise<TransactionRow | undefined> {
  const [directMatch] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.stripeId, paymentId))
    .limit(1);
  if (directMatch) return directMatch;

  if (paymentId.startsWith('pi_')) {
    return resolveTransactionViaPaymentIntent(paymentId, log);
  }
  return undefined;
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

  const txAmountDollars = Number.parseFloat(originalTx.amount);
  const requestedRefundDollars = amount ? amount / 100 : txAmountDollars;

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

  if (totalRefundedDollars + requestedRefundDollars > txAmountDollars + 0.005) {
    return { ok: false, error: 'Refund would exceed original transaction amount', status: 400 };
  }

  return { ok: true, txAmountDollars, requestedRefundDollars, totalRefundedDollars };
}

/** Adjust cash balances for a refund: debit the recipient, credit the payer. */
async function adjustBalancesForRefund(
  toDid: string | null,
  fromDid: string | null,
  refundedDollars: number,
  currency: string,
): Promise<void> {
  if (toDid) {
    await db
      .update(balances)
      .set({ cashAmount: sql`GREATEST(${balances.cashAmount} - ${refundedDollars}, 0)`, updatedAt: new Date() })
      .where(eq(balances.did, toDid));
  }

  if (fromDid) {
    await db
      .insert(balances)
      .values({ did: fromDid, cashAmount: refundedDollars.toString(), creditAmount: '0', currency, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: balances.did,
        set: { cashAmount: sql`${balances.cashAmount} + ${refundedDollars}`, updatedAt: new Date() },
      });
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
    service: originalTx.service,
    type: 'refund',
    fromDid: originalTx.toDid,
    toDid: originalTx.fromDid ?? 'unknown',
    amount: refundedDollars.toString(),
    currency: originalTx.currency,
    status: 'completed',
    source: 'fiat',
    stripeId: refundStripeId,
    metadata: {
      originalTxId: originalTx.id,
      originalStripeId: paymentId,
      ...(reason && { reason }),
    },
  });

  await adjustBalancesForRefund(originalTx.toDid, originalTx.fromDid, refundedDollars, originalTx.currency);

  return { reversalId, isFullRefund };
}

/**
 * Reverse settlement entries (host share + platform fee) linked to the
 * checkout transaction. Settlement transactions link back via
 * `metadata.stripeSessionId` matching the checkout's `stripeId`. Each entry
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
  const checkoutStripeId = originalTx.stripeId;
  if (!checkoutStripeId) return;

  const settlementTxs = await db
    .select()
    .from(transactions)
    .where(sql`${transactions.metadata}->>'stripeSessionId' = ${checkoutStripeId}`);

  const refundFraction = requestedRefundDollars / txAmountDollars;
  const newSettlementStatus = isFullRefund ? 'refunded' : 'partially_refunded';

  for (const stx of settlementTxs) {
    if (stx.status === 'refunded') continue;

    const stxAmount = Number.parseFloat(stx.amount);
    // Proportional reversal amount, rounded to 8 decimal places.
    const stxReversalAmount = Math.round(stxAmount * refundFraction * 1e8) / 1e8;
    if (stxReversalAmount <= 0) continue;

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
      await db
        .update(balances)
        .set({ cashAmount: sql`GREATEST(${balances.cashAmount} - ${stxReversalAmount}, 0)`, updatedAt: new Date() })
        .where(eq(balances.did, stx.toDid));
    }
  }
}
