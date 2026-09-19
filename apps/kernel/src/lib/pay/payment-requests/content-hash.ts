/**
 * `content_hash` for a `pay.payment_request` row (#2206/#2207).
 *
 * `content_hash` is what the `payment_request.issued` / `payment_request.settled`
 * attestations bind — never the raw bytes of the request. Reuses `computeCid`
 * (`@imajin/cid`, the same CIDv1 dag-cbor+SHA-256 primitive
 * `emitMechanicalAttestation` and the public attestation-creation route use
 * for their own `cid` column) so the hash is deterministic, content-addressed,
 * and independent of key order.
 */
import { computeCid } from '@imajin/cid';
import type { PaymentRequestLineItem } from './types';

export interface PaymentRequestContentFields {
  kind: 'invoice' | 'request';
  issuerDid: string;
  payeeAccount: string;
  recipientDid: string | null;
  recipientStubId: string | null;
  lineItems: PaymentRequestLineItem[];
  currency: string;
  totalAmount: number;
  dueAt: string | null;
  allowOnPlatform: boolean;
}

/** Compute the canonical content hash bound by this payment_request's attestations. */
export async function computePaymentRequestContentHash(
  fields: PaymentRequestContentFields,
): Promise<string> {
  return computeCid({
    kind: fields.kind,
    issuerDid: fields.issuerDid,
    payeeAccount: fields.payeeAccount,
    recipientDid: fields.recipientDid,
    recipientStubId: fields.recipientStubId,
    lineItems: fields.lineItems,
    currency: fields.currency,
    totalAmount: fields.totalAmount,
    dueAt: fields.dueAt,
    allowOnPlatform: fields.allowOnPlatform,
  });
}
