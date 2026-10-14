/**
 * Settlement of a hosted checkout (events, market, …) paid on the seller's OWN
 * Stripe account (#2757), driven by that owner's own
 * `stripe.payment_intent.succeeded` event. The generic `POST /pay/api/checkout`
 * counterpart of `payment-requests/byo-settlement.ts`.
 *
 * `pay_transaction_id` — the id of the pending `pay.transactions` row — rides on
 * the session's PaymentIntent metadata (`app/pay/api/checkout/route.ts`), and the
 * connector lifts it onto the owner's bus event. All of these must hold or the
 * event is ignored and nothing is written:
 *   - the row exists, is on the BYO rail, and its `to_did` IS the event's owner
 *     (an owner can only ever settle checkouts made on THEIR account);
 *   - the charge is exactly the row's amount, in its currency;
 *   - the row is still `pending` (a replay is a clean no-op).
 *
 * What it does: the guarded `pending -> completed` transition, then it hands the
 * caller a Checkout-Session-shaped record so the originating service is told it
 * was paid exactly as it is for a platform checkout (`notifyCheckoutServices`).
 *
 * What it deliberately does NOT do: book a processing fee, a `.fair` chain
 * distribution or tax credit. The money landed in the seller's Stripe account,
 * never the platform's, so there is nothing on the platform to distribute — the
 * platform fee on BYO charges is 0 for now (#2754 ruling). The row is also
 * refused by the app-settle path (`app-settle.ts`), which would otherwise credit
 * platform balances with money the platform does not hold.
 */
import { and, eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, transactions } from '@/src/db';
import { retrieveByoCheckoutCustomer, type ByoCheckoutCustomer } from '@/src/lib/stripe/byo-checkout';
import { STRIPE_BYO_RAIL } from './external-ref';
import type { StripeCheckoutSessionLike } from './webhook-event-shapes';

const log = createLogger('kernel');

export interface SettleByoCheckoutInput {
  /** The DID whose own Stripe account emitted the event — the bus envelope's owner. */
  ownerDid: string;
  transactionId: string;
  paymentIntentId: string;
  /** Amount Stripe collected, minor units. */
  amount: number;
  /** Upper-cased ISO currency Stripe collected in. */
  currency: string;
}

export type ByoCheckoutSettlementOutcome =
  | { settled: true; session: StripeCheckoutSessionLike }
  | { settled: false; reason: 'not_found' | 'not_seller' | 'amount_mismatch' | 'not_pending' | 'lost_race' };

type TxRow = typeof transactions.$inferSelect;

/** Row amounts are stored as decimal dollars; Stripe reports minor units. */
function amountMinorOf(row: TxRow): number {
  return Math.round(Number.parseFloat(row.amount) * 100);
}

function stringMetadataOf(row: TxRow): Record<string, string> {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(metadata).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** Why a BYO payment must not settle the checkout it names, or `null` when it may. */
function refusalOf(
  row: TxRow | undefined,
  input: SettleByoCheckoutInput,
): Extract<ByoCheckoutSettlementOutcome, { settled: false }>['reason'] | null {
  if (!row) return 'not_found';
  if (row.toDid !== input.ownerDid) return 'not_seller';
  if (amountMinorOf(row) !== input.amount || row.currency.toUpperCase() !== input.currency) return 'amount_mismatch';
  if (row.status !== 'pending') return 'not_pending';
  return null;
}

/** Who paid, from the owner's own session; a failed read falls back to what the buyer gave us up front. */
async function customerOf(input: SettleByoCheckoutInput, sessionId: string, fallbackEmail: string | undefined): Promise<ByoCheckoutCustomer> {
  try {
    const customer = await retrieveByoCheckoutCustomer(input.ownerDid, sessionId);
    return { email: customer.email ?? fallbackEmail ?? null, name: customer.name };
  } catch (error) {
    log.warn(
      { err: String(error), ownerDid: input.ownerDid, sessionId },
      'BYO checkout settlement: could not read the buyer back from the seller\'s Stripe — using the email given at checkout',
    );
    return { email: fallbackEmail ?? null, name: null };
  }
}

/**
 * Settle the hosted checkout an owner's BYO `payment_intent.succeeded` names.
 * Idempotent: a replay is a clean no-op (`not_pending`). Never settles a
 * checkout whose seller is not the event's owner.
 */
export async function settleCheckoutFromByoStripe(input: SettleByoCheckoutInput): Promise<ByoCheckoutSettlementOutcome> {
  const [row] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, input.transactionId), eq(transactions.rail, STRIPE_BYO_RAIL)))
    .limit(1);

  const refusal = refusalOf(row, input);
  if (refusal || !row) {
    if (refusal !== 'not_pending') {
      log.warn(
        { transactionId: input.transactionId, ownerDid: input.ownerDid, reason: refusal },
        'BYO Stripe payment did not settle the checkout it names — ignored, nothing written',
      );
    }
    return { settled: false, reason: refusal ?? 'not_found' };
  }

  const [completed] = await db
    .update(transactions)
    .set({ status: 'completed' })
    .where(and(eq(transactions.id, row.id), eq(transactions.rail, STRIPE_BYO_RAIL), eq(transactions.status, 'pending')))
    .returning({ id: transactions.id });
  if (!completed) return { settled: false, reason: 'lost_race' };

  const metadata = stringMetadataOf(row);
  const sessionId = row.externalRef ?? input.paymentIntentId;
  const customer = await customerOf(input, sessionId, metadata.customer_email);

  return {
    settled: true,
    session: {
      id: sessionId,
      amount_total: input.amount,
      currency: input.currency.toLowerCase(),
      customer_email: customer.email,
      customer_details: { email: customer.email, name: customer.name },
      metadata,
      payment_intent: input.paymentIntentId,
      // The row is on the `stripe-byo` rail, so the platform-rail session lookup would not find it (#2739).
      transactionId: row.id,
      // #2773: tells market (and any app) the kernel settled this on the seller's own account — do not call /pay/api/settle.
      rail: STRIPE_BYO_RAIL,
      // The row's `to_did` was checked against the event's owner above; metadata.sellerDid is not.
      sellerDid: input.ownerDid,
    },
  };
}
