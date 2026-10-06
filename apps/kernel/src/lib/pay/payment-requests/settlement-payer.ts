/**
 * Who a payment_request's settlement records as the payer (#2665).
 *
 * This is the ONE place that decision is made, shared by every settle path
 * (Stripe webhook, e-Transfer mark-paid, and the operator retry). Today it is
 * the request's recipient, falling back to the issuer for a request with no
 * resolved recipient DID (an unclaimed stub) — exactly what the Stripe path
 * did inline before. #2656 (payer-DID choice) extends THIS function and
 * nothing else; no settle path reads `recipientDid` itself.
 */
import type { PaymentRequest } from '@/src/db';

export function resolveSettlementPayerDid(paymentRequest: Pick<PaymentRequest, 'recipientDid' | 'issuerDid'>): string {
  return paymentRequest.recipientDid ?? paymentRequest.issuerDid;
}
