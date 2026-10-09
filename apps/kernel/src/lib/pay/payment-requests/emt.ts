/**
 * Interac e-Transfer pay-in for a payment_request (#2665).
 *
 * Two steps, both built on the ONE kernel EMT rail (`../rails/emt-pay-in-rail`):
 *
 *  1. `requestEmtPayInstructions` — the payer (anonymous, holding the opaque
 *     pay-link handle) picks "Pay by e-Transfer". The request moves
 *     `issued -> emt_pending` and they get `{ email, amount, memo }`, the
 *     same instruction shape the top-up route (`/pay/api/topup/emt`) returns.
 *     Idempotent: asking again returns the same instructions.
 *
 *  2. `settlePaymentRequestEmt` — the issuer (or whoever acts for the issuer
 *     business) confirms the deposit arrived. `emt_pending -> paid` through a
 *     guarded compare-and-swap, then the SAME ledger settlement the Stripe
 *     webhook runs (`attemptSettlement` in `checkout.ts`): `.fair` resolved
 *     with no processor fee, a settlement attestation naming the rail, and the
 *     `payment_request.settled` event whose notify reactor tells the payer.
 *
 * #2758: choosing e-Transfer is not a one-way door. `revertEmtPending` is the
 * payer's guarded `emt_pending -> issued` ("Pay another way"), allowed only while
 * no deposit has been confirmed; the issuer's confirm path is unchanged.
 *
 * Choosing e-Transfer never blocks paying by card instead, and two
 * settlements on one request are impossible: both rails settle through a
 * compare-and-swap out of the open statuses, so exactly one wins; the other
 * becomes a no-op (card) or a 409 (e-Transfer).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db, paymentRequests, profiles } from '@/src/db';
import type { PaymentRequest } from '@/src/db';
import { createLogger } from '@imajin/logger';
import type { PayInInstructions } from '../rails/types';
import { EMT_RAIL_NAME } from '../rails/emt-pay-in-rail';
import { alertSettlementFailure, attemptSettlement, recordPaidByDid } from './checkout';
import { emtInstructionsFor, emtMemoOf } from './emt-offer';
import { resolvePayerDidChoice } from './payer-dids';
import { findLiveRowByHandle, getPaymentRequestById, type ServiceError } from './service';
import type { PaymentRequestSettlementRef } from './types';

const log = createLogger('kernel');

function err(error: string, status: number): ServiceError {
  return { error, status };
}

/** The issuer's e-Transfer receiving email (#2665), straight off their profile; `null` when unset. */
async function fetchIssuerEtransferEmail(issuerDid: string): Promise<string | null> {
  const [profile] = await db
    .select({ etransferEmail: profiles.etransferEmail })
    .from(profiles)
    .where(eq(profiles.did, issuerDid))
    .limit(1);
  return profile?.etransferEmail ?? null;
}

// ---------------------------------------------------------------------------
// Payer side: choose e-Transfer
// ---------------------------------------------------------------------------

export interface EmtPayInstructionsResult {
  instructions: PayInInstructions;
  /** `true` when the request was already `emt_pending` (the same instructions are simply returned again). */
  alreadyPending: boolean;
}

/** Move `issued -> emt_pending`; `false` when the guarded transition lost to a concurrent change. */
async function markEmtPending(id: string): Promise<boolean> {
  const [row] = await db
    .update(paymentRequests)
    .set({ status: 'emt_pending', updatedAt: new Date() })
    .where(and(eq(paymentRequests.id, id), eq(paymentRequests.status, 'issued')))
    .returning();
  return !!row;
}

/**
 * #2656: the payer's DID choice on the e-Transfer rail. Only an authenticated
 * payer can make one, so the route supplies `personDid` (the signed-in person,
 * `payerPersonDidOf`) alongside the `paidByDid` they picked.
 */
export interface EmtPayerChoice {
  paidByDid: string;
  personDid: string;
}

/**
 * The payer chose "Pay by e-Transfer" on `/pay/r/:handle`. Unauthenticated by
 * design (the pay link is the capability), keyed by the opaque `pay_handle`.
 * 404 for an unknown or void handle, 409 once the request is settled, 400
 * when e-Transfer can't be offered (no receiving email set, on-platform
 * payment disallowed, or a non-CAD request).
 *
 * #2656: a signed-in payer may also pass the DID they are paying as. It is
 * validated server-side (403 when they don't control it) and stored on the
 * row, so the issuer's "Mark paid" settles with `paid_by_did` as the payer.
 * Without a choice nothing is written — an earlier choice is kept.
 */
export async function requestEmtPayInstructions(
  handle: string,
  payer?: EmtPayerChoice,
): Promise<EmtPayInstructionsResult | ServiceError> {
  const row = await findLiveRowByHandle(handle);
  if (!row) return err('payment_request not found', 404);
  if (row.status !== 'issued' && row.status !== 'emt_pending') {
    return err(`cannot pay a payment_request in status '${row.status}' by e-Transfer`, 409);
  }

  const instructions = emtInstructionsFor(row, await fetchIssuerEtransferEmail(row.issuerDid));
  if (!instructions) return err('e-Transfer is not available for this payment_request', 400);

  if (payer) {
    const choice = await resolvePayerDidChoice(payer.paidByDid, payer.personDid);
    if (typeof choice === 'object' && choice !== null) return choice;
    if (choice && !(await recordPaidByDid(row.id, choice))) {
      return err('payment_request status changed concurrently — refresh and retry', 409);
    }
  }

  if (row.status === 'emt_pending') return { instructions, alreadyPending: true };

  if (!(await markEmtPending(row.id))) {
    // Lost a race: a concurrent payer chose e-Transfer too (fine), or it settled / was voided (not).
    const current = await getPaymentRequestById(row.id);
    if (current?.status !== 'emt_pending') {
      return err('payment_request status changed concurrently — refresh and retry', 409);
    }
    return { instructions, alreadyPending: true };
  }

  log.info({ paymentRequestId: row.id }, 'payment_request e-Transfer instructions issued — emt_pending');
  return { instructions, alreadyPending: false };
}

// ---------------------------------------------------------------------------
// Payer side: leave e-Transfer (#2758)
// ---------------------------------------------------------------------------

export interface RevertEmtResult {
  paymentRequest: PaymentRequest;
  /** `false` when the request was already back at `issued` (a double-click or a second tab — a clean no-op). */
  reverted: boolean;
}

/**
 * The payer picked e-Transfer and changed their mind: `emt_pending -> issued`
 * ("Pay another way"). Unauthenticated like the choice itself — the opaque
 * `pay_handle` is the capability.
 *
 * Allowed ONLY while no deposit has been confirmed. Confirming is the issuer's
 * `emt_pending -> paid` (`settlePaymentRequestEmt`), so "no deposit confirmed"
 * is exactly "still `emt_pending` with no settlement ref" — and the revert is a
 * compare-and-swap on that, so it can never undo a confirmation: if the issuer
 * confirmed first this loses and answers 409. The issuer's side is untouched:
 * a reverted request is `issued` again, and if the transfer arrives anyway the
 * issuer settles it with the existing manual settle (valid from `issued`) —
 * or the payer chooses e-Transfer again, which returns the same memo (derived
 * from the request id) and re-opens `Mark paid (e-Transfer)`.
 *
 *  - 404 unknown/void handle; 409 once paid/settled (a deposit was confirmed);
 *  - already `issued` -> no-op success.
 */
export async function revertEmtPending(handle: string): Promise<RevertEmtResult | ServiceError> {
  const row = await findLiveRowByHandle(handle);
  if (!row) return err('payment_request not found', 404);
  if (row.status === 'issued') return { paymentRequest: row, reverted: false };
  if (row.status !== 'emt_pending') {
    return err(`cannot leave e-Transfer on a payment_request in status '${row.status}' — a payment has already been confirmed`, 409);
  }

  const [issuedRow] = await db
    .update(paymentRequests)
    .set({ status: 'issued', updatedAt: new Date() })
    .where(
      and(
        eq(paymentRequests.id, row.id),
        eq(paymentRequests.status, 'emt_pending'),
        isNull(paymentRequests.settlementRef),
      ),
    )
    .returning();
  if (!issuedRow) {
    // Lost the guarded transition: the issuer confirmed the deposit first (409), or a concurrent revert won (fine).
    const current = await getPaymentRequestById(row.id);
    if (current?.status === 'issued') return { paymentRequest: current, reverted: false };
    return err('payment_request status changed concurrently — a payment may have just been confirmed; refresh', 409);
  }

  log.info({ paymentRequestId: row.id }, 'payment_request e-Transfer choice withdrawn — back to issued');
  return { paymentRequest: issuedRow, reverted: true };
}

// ---------------------------------------------------------------------------
// Issuer side: Mark paid (e-Transfer)
// ---------------------------------------------------------------------------

export interface SettlePaymentRequestEmtInput {
  id: string;
  /** The authenticated caller's resolved effective DID (`resolveActingDid`) — the issuer business when acting for it. */
  callerDid: string;
}

export interface SettledEmtResult {
  paymentRequest: PaymentRequest;
  /** `false` when this call was an idempotent no-op (the request was already settled by e-Transfer). */
  settled: boolean;
}

/** True when `row` was already settled through the e-Transfer rail — i.e. this call is a replay. */
function settledByEmt(row: PaymentRequest): boolean {
  const ref = row.settlementRef as PaymentRequestSettlementRef | null;
  return row.status === 'paid' && ref?.method === EMT_RAIL_NAME;
}

/**
 * Mark a payment_request paid by e-Transfer. Issuer-only, enforced HERE
 * (server-side) — the route passes `resolveActingDid`, so the caller is
 * either the issuer or someone acting for the issuer business; anyone else
 * (including the payer) is refused with a 403 before anything is read or
 * written beyond the request itself.
 *
 *  - 404 unknown id; 403 not the issuer;
 *  - idempotent: a replay on a request already settled by e-Transfer is a
 *    clean no-op (`settled: false`) and never touches the ledger again;
 *  - 409 when the request is in any other status, which is also what stops a
 *    second settlement across rails — a card payment that already won the
 *    race left it `paid`, so this loses.
 */
export async function settlePaymentRequestEmt(
  input: SettlePaymentRequestEmtInput,
): Promise<SettledEmtResult | ServiceError> {
  const existing = await getPaymentRequestById(input.id);
  if (!existing) return err('payment_request not found', 404);
  if (existing.issuerDid !== input.callerDid) {
    return err('only the issuer, or someone acting for the issuer business, may mark this payment_request paid', 403);
  }
  if (settledByEmt(existing)) return { paymentRequest: existing, settled: false };
  if (existing.status !== 'emt_pending') {
    return err(
      `cannot mark a payment_request in status '${existing.status}' paid by e-Transfer (only valid from 'emt_pending')`,
      409,
    );
  }

  const settledAt = new Date();
  const settlementRef: PaymentRequestSettlementRef = {
    method: EMT_RAIL_NAME,
    asserted_by: input.callerDid,
    reference: emtMemoOf(existing),
    settled_at: settledAt.toISOString(),
  };

  const [paidRow] = await db
    .update(paymentRequests)
    .set({ status: 'paid', settlementRef, updatedAt: settledAt })
    .where(and(eq(paymentRequests.id, input.id), eq(paymentRequests.status, 'emt_pending')))
    .returning();
  if (!paidRow) {
    // Lost the guarded transition: a double-click / concurrent confirm (no-op), or a card payment settled first (409).
    const current = await getPaymentRequestById(input.id);
    if (current && settledByEmt(current)) return { paymentRequest: current, settled: false };
    return err('payment_request status changed concurrently — refresh and retry', 409);
  }

  const outcome = await attemptSettlement(paidRow, settlementRef);
  if (!outcome.ok) {
    await alertSettlementFailure(paidRow, outcome, EMT_RAIL_NAME);
    return err(
      `marked paid, but the ledger settlement failed (${outcome.reason}) — the operator has been alerted and can retry it`,
      422,
    );
  }
  return { paymentRequest: paidRow, settled: true };
}
