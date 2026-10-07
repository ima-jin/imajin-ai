/**
 * Who a payment_request's settlement records as the payer (#2665).
 *
 * This is the ONE place that decision is made, shared by every settle path
 * (Stripe webhook, e-Transfer mark-paid, and the operator retry). Today it is
 * the request's recipient, falling back to the issuer for a request with no
 * resolved recipient DID (an unclaimed stub) — exactly what the Stripe path
 * did inline before. No settle path reads `recipientDid` itself.
 *
 * #2656: when the payer chose which of their DIDs pays (`paid_by_did` — own
 * DID or an org/business they control, validated server-side before it is
 * stored), that DID is the payer and wins over the recipient. The invoice
 * itself stays addressed to the recipient.
 */
import type { PaymentRequest } from '@/src/db';

export function resolveSettlementPayerDid(
  paymentRequest: Pick<PaymentRequest, 'recipientDid' | 'issuerDid'> & { paidByDid?: string | null },
): string {
  return paymentRequest.paidByDid ?? paymentRequest.recipientDid ?? paymentRequest.issuerDid;
}

/**
 * The DID a receipt / attestation names as having paid — `paid_by_did ??
 * recipient_did`, `null` for an unclaimed stub nobody has picked a payer for
 * (unlike settlement, there is no issuer fallback: the issuer is the payee).
 */
export function payingDidOf(paymentRequest: Pick<PaymentRequest, 'recipientDid'> & { paidByDid?: string | null }): string | null {
  return paymentRequest.paidByDid ?? paymentRequest.recipientDid;
}
