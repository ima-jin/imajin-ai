/**
 * Settlement of a payment_request paid on the issuer's OWN Stripe account
 * (#2754), driven by that owner's own `stripe.payment_intent.succeeded` event
 * (the #1785 connector republishes it with the PaymentIntent's
 * `payment_request_id`, which `byo-checkout.ts` wrote at checkout).
 *
 * This is the ONE exception to "an owner's BYO event never touches the
 * platform ledger": it narrows that rule, it does not delete it. All of these
 * must hold or the event is ignored (and nothing is written):
 *   - the payment_request exists and its `issuer_did` IS the event's owner DID
 *     (an owner can only ever settle their OWN requests);
 *   - the charge is exactly the request's total, in its currency;
 *   - the request is still open (a replay, or a request settled another way, is a no-op).
 *
 * What it does: the guarded `issued|emt_pending -> paid` transition (so across
 * card, e-Transfer and replay exactly one settlement wins), a completed
 * `pay.transactions` row on the BYO rail with the PaymentIntent as its
 * `external_ref`, the kernel-signed `payment_request.settled` attestation, and
 * the `payment_request.paid` / `.settled` announcements.
 *
 * What it deliberately does NOT do: run `settlePayment()`. The money landed in
 * the issuer's Stripe account, never the platform's, so there is no balance,
 * chain share, fee or tax credit to book — the platform balance does not move.
 * The platform fee on BYO invoices is 0 for now (#2754 ruling); that is stamped
 * on the transaction row's manifest so the zero is on the record, not implied.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, paymentRequests, transactions } from '@/src/db';
import type { PaymentRequest } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { externalRefColumns, STRIPE_BYO_RAIL } from '@/src/lib/pay/external-ref';
import {
  OPEN_STATUSES,
  announcePaymentRequestPaid,
  attestAndAnnounceStripeSettled,
  isOpenStatus,
} from './checkout';
import { getPaymentRequestById } from './service';
import { payingDidOf } from './settlement-payer';
import type { PaymentRequestSettlementRef } from './types';

const log = createLogger('kernel');

export interface SettleByoPaymentRequestInput {
  /** The DID whose own Stripe account emitted the event — the bus envelope's owner. */
  ownerDid: string;
  paymentRequestId: string;
  paymentIntentId: string;
  /** Amount Stripe collected, minor units. */
  amount: number;
  /** Upper-cased ISO currency Stripe collected in. */
  currency: string;
}

export type ByoSettlementOutcome =
  | { settled: true; paymentRequest: PaymentRequest }
  | {
      settled: false;
      reason: 'not_found' | 'not_issuer' | 'amount_mismatch' | 'not_open' | 'lost_race';
    };

/** The platform fee a BYO invoice carries today (#2754 ruling a): none. Recorded as an explicit 0, never omitted. */
const BYO_PLATFORM_FEE = { rateBps: 0, amountCents: 0, reason: 'byo_no_platform_fee' } as const;

/** The request's stored `.fair` manifest with the explicit zero platform fee stamped on — the transaction row's copy, never the signed original. */
function manifestWithZeroPlatformFee(request: PaymentRequest): Record<string, unknown> {
  const manifest = (request.fairManifest ?? {}) as Record<string, unknown>;
  return { ...manifest, platformFee: BYO_PLATFORM_FEE };
}

/** True when `request` already settled via exactly this PaymentIntent (a webhook replay — normal, not worth a log line). */
function isReplayOf(request: PaymentRequest, paymentIntentId: string): boolean {
  const ref = request.settlementRef as PaymentRequestSettlementRef | null;
  return ref?.method === 'stripe' && ref.payment_intent_id === paymentIntentId;
}

/** Insert the completed BYO-rail transaction row, unless one for this PaymentIntent already exists. */
async function recordByoTransaction(paid: PaymentRequest, paymentIntentId: string): Promise<void> {
  const [existing] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.rail, STRIPE_BYO_RAIL), eq(transactions.externalRef, paymentIntentId)))
    .limit(1);
  if (existing) return;

  await db.insert(transactions).values({
    id: generateId('tx'),
    service: 'payment_request',
    type: 'payment_request_byo_charge',
    fromDid: payingDidOf(paid),
    toDid: paid.issuerDid,
    amount: (paid.totalAmount / 100).toString(),
    currency: paid.currency,
    status: 'completed',
    ...externalRefColumns(paymentIntentId, STRIPE_BYO_RAIL),
    metadata: { payment_request_id: paid.id, payment_intent_id: paymentIntentId, platform_fee_cents: 0 },
    fairManifest: manifestWithZeroPlatformFee(paid),
  });
}

/** Why a BYO payment must not settle the request it names, or `null` when it may. */
function refusalOf(
  existing: PaymentRequest | null,
  input: SettleByoPaymentRequestInput,
): Extract<ByoSettlementOutcome, { settled: false }>['reason'] | null {
  if (!existing) return 'not_found';
  if (existing.issuerDid !== input.ownerDid) return 'not_issuer';
  if (input.amount !== existing.totalAmount || input.currency !== existing.currency.toUpperCase()) {
    return 'amount_mismatch';
  }
  return null;
}

/**
 * Settle the payment_request an owner's BYO `payment_intent.succeeded` names.
 * Idempotent: a replay, or a request already settled another way, is a clean
 * no-op (`not_open`). Never settles a request the event's owner does not own.
 */
export async function settlePaymentRequestFromByoStripe(
  input: SettleByoPaymentRequestInput,
): Promise<ByoSettlementOutcome> {
  const existing = await getPaymentRequestById(input.paymentRequestId);
  const refusal = refusalOf(existing, input);
  if (refusal || !existing) {
    log.warn(
      { paymentRequestId: input.paymentRequestId, ownerDid: input.ownerDid, reason: refusal },
      'BYO Stripe payment did not settle the payment_request it names — ignored, nothing written',
    );
    return { settled: false, reason: refusal ?? 'not_found' };
  }

  if (!isOpenStatus(existing.status)) {
    if (!isReplayOf(existing, input.paymentIntentId)) {
      log.error(
        { paymentRequestId: existing.id, requestStatus: existing.status, paymentIntentId: input.paymentIntentId },
        'BYO Stripe payment landed on a payment_request that is already settled by another payment — issuer needs to review a refund',
      );
    }
    return { settled: false, reason: 'not_open' };
  }

  const settlementRef: PaymentRequestSettlementRef = {
    method: 'stripe',
    payment_intent_id: input.paymentIntentId,
    byo: true,
    settled_at: new Date().toISOString(),
  };
  const [paid] = await db
    .update(paymentRequests)
    .set({ status: 'paid', settlementRef, updatedAt: new Date() })
    .where(and(eq(paymentRequests.id, existing.id), inArray(paymentRequests.status, [...OPEN_STATUSES])))
    .returning();
  if (!paid) return { settled: false, reason: 'lost_race' };

  // The request is Paid and announced either way; a failed ledger-row write must not strand the attestation.
  await recordByoTransaction(paid, input.paymentIntentId).catch((error: unknown) =>
    log.error({ err: String(error), paymentRequestId: paid.id }, 'BYO Stripe settlement: transaction row write failed'),
  );
  announcePaymentRequestPaid(paid, settlementRef);
  await attestAndAnnounceStripeSettled(paid, settlementRef, (await getNodeDid()) || null);

  return { settled: true, paymentRequest: paid };
}
