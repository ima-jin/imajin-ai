/**
 * Attest + announce an e-Transfer settlement (#2665) — the EMT counterpart of
 * `attestAndAnnounceStripeSettled` in `checkout.ts`.
 *
 * The difference is who signs. A Stripe settlement is kernel-signed (the
 * webhook asserted it); an e-Transfer settlement is a HUMAN assertion — the
 * issuer (or whoever acts for the issuer business) confirmed the deposit
 * arrived — so the attestation is issuer-signed and records `asserted_by`,
 * the same shape as a manual settlement but with `method: 'emt'` naming the
 * rail and `reference` carrying the memo the deposit was matched against.
 *
 * Kept out of `checkout.ts` so that module's existing mocks (which stub only
 * the Stripe attestation emitter) are untouched.
 */
import type { PaymentRequest } from '@/src/db';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { emitPaymentRequestSettledAttestation } from './attestations';
import { payingDidOf } from './settlement-payer';
import { taxBreakdownOf } from './tax';
import type { PaymentRequestSettlementRef } from './types';

const log = createLogger('kernel');

export async function attestAndAnnounceEmtSettled(
  paymentRequest: PaymentRequest,
  settlementRef: PaymentRequestSettlementRef,
): Promise<void> {
  const assertedBy = settlementRef.asserted_by ?? paymentRequest.issuerDid;

  const attestationId = await emitPaymentRequestSettledAttestation({
    paymentRequestId: paymentRequest.id,
    issuerDid: paymentRequest.issuerDid,
    recipientDid: paymentRequest.recipientDid,
    paidByDid: payingDidOf(paymentRequest),
    method: 'emt',
    assertedBy,
    reference: settlementRef.reference,
    contentHash: paymentRequest.contentHash,
    totalAmount: paymentRequest.totalAmount,
    currency: paymentRequest.currency,
    tax: taxBreakdownOf(paymentRequest),
  });

  // The `payment_request-settled` notify reactor sends the payer (recipient) their notification from this event.
  publish('payment_request.settled', {
    issuer: assertedBy,
    subject: paymentRequest.recipientDid ?? paymentRequest.issuerDid,
    scope: 'pay',
    payload: {
      paymentRequestId: paymentRequest.id,
      method: 'emt',
      issuerDid: paymentRequest.issuerDid,
      recipientDid: paymentRequest.recipientDid,
      paidByDid: payingDidOf(paymentRequest),
      totalAmount: paymentRequest.totalAmount,
      currency: paymentRequest.currency,
      contentHash: paymentRequest.contentHash,
      settlementRef: settlementRef as unknown as Record<string, unknown>,
      attestationId,
      context_id: paymentRequest.id,
      context_type: 'payment_request',
    },
  }).catch((error: unknown) => log.error({ err: String(error) }, 'payment_request.settled (emt) publish error'));
}
