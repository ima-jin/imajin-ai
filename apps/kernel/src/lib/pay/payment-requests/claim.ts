/**
 * `recipient_stub_id` -> `recipient_did` re-pointing on claim (#2206/#2210).
 *
 * The claimable-stub recipient's "claim" (per #1834, "claim = consent
 * event") is, for a payment_request, exactly the moment they connect to
 * the issuer — accepting the invite the issuer sent, or clicking through
 * as the pre-minted stub. That is already the `connection.accepted`
 * moment the connections accept route (`app/connections/api/invites/[code]
 * /accept/route.ts`) publishes, so this module is called directly from
 * there rather than wired as a separate bus reactor — #2212 (bus_chain_
 * configs rows / a notify reactor for payment_request.* events) is
 * explicitly out of scope here.
 *
 * Both recipient orderings converge on this same call:
 *  - claim-first: the recipient accepts the invite before ever paying —
 *    this resolves `recipient_did` immediately, and they go on to pay as
 *    a known DID.
 *  - pay-first: the recipient already paid via the opaque pay-link handle
 *    (`GET /pay/api/payment-requests/by-handle/:handle`, #2209's job) while
 *    the request was still addressed to the stub, then claims afterwards —
 *    this call re-points the already-issued/settled request onto the now-
 *    known DID.
 *
 * The DID never changes across claim (#1834 point 1: "the DID survives
 * the claim") — `claimedDid` is simultaneously the request's former
 * `recipient_stub_id` and its new `recipient_did`. This only flips which
 * of the two mutually-exclusive columns is populated (enforced by the
 * `pay_payment_request_recipient_xor_check` CHECK constraint); it never
 * touches the `payment_request.issued` / `.settled` attestations already
 * minted against the request — the re-point is always its own new
 * `payment_request.recipient_claimed` record.
 */
import { and, eq } from 'drizzle-orm';
import { db, paymentRequests } from '@/src/db';
import type { PaymentRequest } from '@/src/db';
import { publish } from '@imajin/bus';
import { emitMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * Re-point every payment_request currently addressed to `claimedDid` as a
 * `recipient_stub_id`. Idempotent and safe to call more than once for the
 * same DID (e.g. a reconnect, or the connections accept route's two
 * `connection.accepted` publishes) — a request already resolved on a
 * prior call simply no longer matches the `WHERE recipient_stub_id = ...`
 * guard and is skipped.
 */
export async function resolvePaymentRequestsOnRecipientClaim(claimedDid: string): Promise<void> {
  const addressed = await db
    .select()
    .from(paymentRequests)
    .where(eq(paymentRequests.recipientStubId, claimedDid));

  for (const row of addressed) {
    await resolveOne(row, claimedDid);
  }
}

async function resolveOne(row: PaymentRequest, claimedDid: string): Promise<void> {
  const [updated] = await db
    .update(paymentRequests)
    .set({ recipientDid: claimedDid, recipientStubId: null, updatedAt: new Date() })
    .where(and(eq(paymentRequests.id, row.id), eq(paymentRequests.recipientStubId, claimedDid)))
    .returning();
  // Already resolved by a concurrent/prior call — nothing left to do.
  if (!updated) return;

  const attestationId = await emitMechanicalAttestation({
    subjectDid: claimedDid,
    type: 'payment_request.recipient_claimed',
    contextId: row.id,
    contextType: 'payment_request',
    payload: {
      payment_request_id: row.id,
      issuer_did: row.issuerDid,
      recipient_did: claimedDid,
      recipient_stub_id: claimedDid,
      content_hash: row.contentHash,
    },
  });

  publish('payment_request.recipient_claimed', {
    issuer: row.issuerDid,
    subject: claimedDid,
    scope: 'pay',
    payload: {
      paymentRequestId: row.id,
      issuerDid: row.issuerDid,
      recipientDid: claimedDid,
      recipientStubId: claimedDid,
      totalAmount: row.totalAmount,
      currency: row.currency,
      contentHash: row.contentHash,
      attestationId,
      context_id: row.id,
      context_type: 'payment_request',
    },
  }).catch((err: unknown) => {
    log.error({ err: String(err), paymentRequestId: row.id }, '[payment_request] recipient_claimed publish error');
  });
}
