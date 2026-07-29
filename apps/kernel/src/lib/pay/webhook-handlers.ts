/**
 * Webhook handler helpers — kernel pay domain
 *
 * Extracted from apps/kernel/app/pay/api/webhook/route.ts to bring
 * handleCheckoutCompleted's cognitive complexity (S3776) below 15.
 *
 * Public surface (exported) is intentionally narrow — only the pieces
 * that are reused from the route or tested in isolation are exported.
 */

import Stripe from 'stripe';
import { db, feeLedger, balances, balanceRollups, transactions } from '@/src/db';
import { sql } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { STRIPE_RATE_BPS, STRIPE_FIXED_CENTS } from '@imajin/fair';
import { getStripe } from './stripe';

const log = createLogger('kernel');

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface FairManifest {
  fees?: Array<{ role: string; name: string; rateBps: number; fixedCents: number }>;
  chain?: Array<{ did: string; role: string; share: number }>;
}

/** Minimal shape of a kernel transaction row needed by these helpers. */
export interface TxRow {
  id: string;
  service?: string | null;
}

// ---------------------------------------------------------------------------
// Fee helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to retrieve the actual Stripe processing fee from the
 * balance_transaction attached to the checkout session's payment intent.
 * Returns `null` when the fee cannot be read (not yet settled, API error, etc.).
 */
export async function fetchActualStripeFee(
  session: Stripe.Checkout.Session,
  transactionId: string,
): Promise<number | null> {
  const paymentIntentId = session.payment_intent as string | null;
  if (!paymentIntentId) return null;

  try {
    const stripe = getStripe();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.balance_transaction'],
    });
    const charge = pi.latest_charge as Stripe.Charge | null;
    const bt = charge?.balance_transaction as Stripe.BalanceTransaction | null | undefined;
    if (bt?.fee) {
      log.info(
        { transactionId, stripeFee: bt.fee, feeDetails: bt.fee_details },
        '[webhook] Actual Stripe fee from balance_transaction',
      );
      return bt.fee;
    }
    return null;
  } catch (err) {
    log.warn({ err: String(err) }, '[webhook] Failed to fetch balance_transaction — using estimate');
    return null;
  }
}

/**
 * Calculate the estimated processing fee from the .fair manifest's processor
 * entry, falling back to the platform-wide Stripe rate constants.
 * Pure function — no side effects.
 */
export function calculateEstimatedFee(manifest: FairManifest, totalAmountCents: number): number {
  const feeEntry = manifest.fees?.find(f => f.role === 'processor');
  return feeEntry
    ? Math.round((totalAmountCents * feeEntry.rateBps) / 10000) + (feeEntry.fixedCents || 0)
    : Math.round((totalAmountCents * STRIPE_RATE_BPS) / 10000) + STRIPE_FIXED_CENTS;
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
  await db.insert(feeLedger).values({
    id: generateId('fl'),
    transactionId: tx.id,
    recipientDid: sellerDid,
    role: 'processor_rebate',
    amountCents: diffCents,
    currency,
    status: 'accrued',
  });

  await db
    .insert(balances)
    .values({ did: sellerDid, cashAmount: '0', creditAmount: (diffCents / 100).toFixed(8), currency })
    .onConflictDoUpdate({
      target: balances.did,
      set: {
        creditAmount: sql`${balances.creditAmount} + ${(diffCents / 100).toFixed(8)}`,
        updatedAt: new Date(),
      },
    });

  log.info(
    { transactionId: tx.id, sellerDid, rebateCents: diffCents, estimatedFeeCents, actualFeeCents },
    '[webhook] Processing fee rebate → MJNx',
  );
  publish('fee.rebate', {
    issuer: process.env.PLATFORM_DID || 'system',
    subject: sellerDid,
    scope: 'pay',
    payload: { transactionId: tx.id, sellerDid, amountCents: diffCents, currency },
  }).catch((err) => log.error({ err: String(err) }, 'fee.rebate publish error'));
}

async function applyFeeSurcharge({
  tx, sellerDid, diffCents, estimatedFeeCents, actualFeeCents, currency,
}: FeeAdjustmentParams): Promise<void> {
  await db.insert(feeLedger).values({
    id: generateId('fl'),
    transactionId: tx.id,
    recipientDid: sellerDid,
    role: 'processor_surcharge',
    amountCents: diffCents,
    currency,
    status: 'accrued',
  });

  await db
    .insert(balances)
    .values({ did: sellerDid, cashAmount: '0', creditAmount: (-diffCents / 100).toFixed(8), currency })
    .onConflictDoUpdate({
      target: balances.did,
      set: {
        creditAmount: sql`${balances.creditAmount} + ${(-diffCents / 100).toFixed(8)}`,
        updatedAt: new Date(),
      },
    });

  log.info(
    { transactionId: tx.id, sellerDid, surchargeCents: diffCents, estimatedFeeCents, actualFeeCents },
    '[webhook] Processing fee surcharge → MJNx debit',
  );
  publish('fee.surcharge', {
    issuer: process.env.PLATFORM_DID || 'system',
    subject: sellerDid,
    scope: 'pay',
    payload: { transactionId: tx.id, sellerDid, amountCents: diffCents, currency },
  }).catch((err) => log.error({ err: String(err) }, 'fee.surcharge publish error'));
}

// ---------------------------------------------------------------------------
// Chain distribution
// ---------------------------------------------------------------------------

export interface ProcessChainDistributionParams {
  tx: TxRow;
  totalAmountCents: number;
  currency: string;
  buyerDid: string | null;
  chain: Array<{ did: string; role: string; share: number }>;
}

/**
 * Walk the .fair manifest chain and write a fee-ledger row, balance credit,
 * and daily rollup for every participant (node, scope, buyer_credit, etc.).
 */
export async function processChainDistribution({
  tx,
  totalAmountCents,
  currency,
  buyerDid,
  chain,
}: ProcessChainDistributionParams): Promise<void> {
  for (const entry of chain) {
    const amountCents = Math.round(totalAmountCents * entry.share);
    if (amountCents <= 0) continue;

    const recipientDid =
      entry.did === 'BUYER_PLACEHOLDER' ? (buyerDid || 'unresolved') : entry.did;
    const isSeller = entry.role === 'seller';
    const isBuyerCredit = entry.role === 'buyer_credit';
    const status = isSeller ? 'paid_out' : 'accrued';

    await db.insert(feeLedger).values({
      id: generateId('fl'),
      transactionId: tx.id,
      recipientDid,
      role: entry.role,
      amountCents,
      currency,
      status,
    });

    publish('fee.record', {
      issuer: process.env.PLATFORM_DID || 'system',
      subject: recipientDid,
      scope: 'pay',
      payload: { transactionId: tx.id, recipientDid, role: entry.role, amountCents, currency },
    }).catch((err) => log.error({ err: String(err) }, 'fee.record publish error'));

    // Seller's payout goes directly to their Stripe — skip balance bookkeeping.
    if (recipientDid !== 'unresolved' && !isSeller) {
      await updateRecipientBalance({ recipientDid, isBuyerCredit, amountCents, currency });
      await updateDailyRollup({ tx, recipientDid, amountCents });
    }
  }
}

interface UpdateRecipientBalanceParams {
  recipientDid: string;
  isBuyerCredit: boolean;
  amountCents: number;
  currency: string;
}

async function updateRecipientBalance({
  recipientDid,
  isBuyerCredit,
  amountCents,
  currency,
}: UpdateRecipientBalanceParams): Promise<void> {
  const amountStr = (amountCents / 100).toFixed(8);

  if (isBuyerCredit) {
    // Buyer credit → creditAmount (virtual MJN token)
    await db
      .insert(balances)
      .values({ did: recipientDid, cashAmount: '0', creditAmount: amountStr, currency })
      .onConflictDoUpdate({
        target: balances.did,
        set: {
          creditAmount: sql`${balances.creditAmount} + ${amountStr}`,
          updatedAt: new Date(),
        },
      });
  } else {
    // Fee beneficiary (protocol, node, scope) → cashAmount held in Imajin account
    await db
      .insert(balances)
      .values({ did: recipientDid, cashAmount: amountStr, creditAmount: '0', currency })
      .onConflictDoUpdate({
        target: balances.did,
        set: {
          cashAmount: sql`${balances.cashAmount} + ${amountStr}`,
          updatedAt: new Date(),
        },
      });
  }
}

interface UpdateDailyRollupParams {
  tx: TxRow;
  recipientDid: string;
  amountCents: number;
}

async function updateDailyRollup({ tx, recipientDid, amountCents }: UpdateDailyRollupParams): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const amountStr = (amountCents / 100).toFixed(8);

  await db
    .insert(balanceRollups)
    .values({
      did: recipientDid,
      date: today,
      service: tx.service || 'unknown',
      earned: amountStr,
      spent: '0',
      txCount: 1,
    })
    .onConflictDoUpdate({
      target: [balanceRollups.did, balanceRollups.date, balanceRollups.service],
      set: {
        earned: sql`${balanceRollups.earned} + ${amountStr}`,
        txCount: sql`${balanceRollups.txCount} + 1`,
      },
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
export async function handleTopupCheckout(session: Stripe.Checkout.Session): Promise<void> {
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
      status: 'completed',
      stripeId: session.id,
      source: 'fiat',
      metadata: { ...session.metadata, checkoutSessionId: session.id },
    });

    await tx
      .insert(balances)
      .values({
        did: buyerDid,
        cashAmount: topupAmount.toString(),
        creditAmount: '0',
        currency,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: balances.did,
        set: {
          cashAmount: sql`${balances.cashAmount} + ${topupAmount}`,
          updatedAt: new Date(),
        },
      });
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
 * Notify downstream services (events, market) after a non-topup checkout
 * completes.
 */
export async function notifyCheckoutServices(session: Stripe.Checkout.Session): Promise<void> {
  if (session.metadata?.eventId) {
    await notifyEventsService('checkout.completed', session);
  }

  if (session.metadata?.service === 'market' && session.metadata?.sellerDid) {
    publishMarketNotifications(session);
  }
}

function publishMarketNotifications(session: Stripe.Checkout.Session): void {
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

export async function notifyEventsService(
  type: 'checkout.completed' | 'payment.failed',
  session: Stripe.Checkout.Session,
): Promise<void> {
  const eventsServiceUrl = process.env.EVENTS_SERVICE_URL!;
  const webhookSecret = process.env.EVENTS_WEBHOOK_SECRET!;

  try {
    const response = await fetch(`${eventsServiceUrl}/api/webhook/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${webhookSecret}`,
      },
      body: JSON.stringify({
        type,
        sessionId: session.id,
        paymentId:
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id,
        customerEmail: session.customer_email || session.customer_details?.email || null,
        customerName: session.customer_details?.name || null,
        amountTotal: session.amount_total,
        currency: session.currency,
        metadata: session.metadata,
      }),
    });

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
