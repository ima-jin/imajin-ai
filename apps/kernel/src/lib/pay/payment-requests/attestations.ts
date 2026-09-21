/**
 * `payment_request.issued` / `payment_request.settled` attestations
 * (#2206/#2208), signed by the payment_request's issuer DID — never the
 * platform node identity.
 *
 * This deliberately does NOT reuse `emitMechanicalAttestation`
 * (`apps/kernel/src/lib/auth/emit-mechanical-attestation.ts`): that shared
 * primitive always records `issuerDid: platformDid` (a platform-witnessed
 * fact about a subject), which is the wrong shape here — #2208 requires
 * "signed by the issuer" and "the issuer signs manual [settlement] — the
 * record says who asserted it". The actual Ed25519 signature is still
 * produced with `AUTH_PRIVATE_KEY`, the same custodial "node signs as a
 * witness" model `POST /auth/api/identity/:did/sign` documents for
 * chain-verified identities — this module just records the attested
 * party's own DID in `issuerDid` rather than the node's.
 *
 * Exactly ONE `issued` attestation is minted per request (on create) and
 * exactly ONE `settled` per settlement (on manual settle) — callers
 * (`service.ts`) never call this more than once per lifecycle transition,
 * and a payment_request's status transitions (issued -> settled_manual |
 * void, both terminal) make a second call structurally unreachable.
 */
import { db, attestations } from '@/src/db';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import type { AttestationType } from '@imajin/auth';
import { computeCid } from '@imajin/cid';
import { createLogger } from '@imajin/logger';
import { randomUUID } from 'node:crypto';
import { emitMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import type { PaymentRequestSettlementRef } from './types';

const log = createLogger('kernel');

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export interface IssuerSignedAttestationParams {
  /** The DID this attestation is recorded as issued by — the payment_request's issuer, not the platform. */
  issuerDid: string;
  subjectDid: string;
  type: AttestationType;
  contextId: string;
  contextType: 'payment_request';
  payload: Record<string, unknown>;
}

/**
 * Non-fatal by design, matching `emitMechanicalAttestation`: a missing
 * `AUTH_PRIVATE_KEY`, a signing error, or a DB failure all skip/log rather
 * than throw — an attestation gap must never block the underlying
 * create/void/settle write it documents. Returns the written attestation's
 * id, or `null` when the write was skipped/failed.
 */
export async function emitIssuerSignedAttestation(params: IssuerSignedAttestationParams): Promise<string | null> {
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    log.warn({ type: params.type }, 'payment_request attestation skipped: AUTH_PRIVATE_KEY not set');
    return null;
  }

  const issuedAtMs = Date.now();
  const canonicalPayload = canonicalize({
    subject_did: params.subjectDid,
    type: params.type,
    context_id: params.contextId,
    context_type: params.contextType,
    payload: params.payload,
    issued_at: issuedAtMs,
  });

  const id = genId('att');
  try {
    const signature = authCrypto.signSync(canonicalPayload, privateKey);

    let cid: string | null = null;
    try {
      cid = await computeCid({
        issuerDid: params.issuerDid,
        subjectDid: params.subjectDid,
        type: params.type,
        contextId: params.contextId,
        contextType: params.contextType,
        payload: params.payload,
        issuedAt: issuedAtMs,
      });
    } catch { /* non-fatal */ }

    await db.insert(attestations).values({
      id,
      issuerDid: params.issuerDid,
      subjectDid: params.subjectDid,
      type: params.type,
      contextId: params.contextId,
      contextType: params.contextType,
      payload: params.payload,
      signature,
      cid,
      // Mechanical/unilateral (#2208) — never bilateral, never awaiting a countersignature.
      attestationStatus: null,
      issuedAt: new Date(issuedAtMs),
    });
    return id;
  } catch (err) {
    log.error({ err: String(err), type: params.type }, 'payment_request attestation error');
    return null;
  }
}

/** Exactly ONE `payment_request.issued` per request, binding `content_hash`, signed by the issuer. */
export async function emitPaymentRequestIssuedAttestation(params: {
  paymentRequestId: string;
  issuerDid: string;
  recipientDid: string | null;
  recipientStubId: string | null;
  kind: string;
  totalAmount: number;
  currency: string;
  contentHash: string;
}): Promise<string | null> {
  return emitIssuerSignedAttestation({
    issuerDid: params.issuerDid,
    // The recipient is who the fact is about, when known; a claimable-stub
    // recipient has no DID yet, so the record is self-referential until
    // #2210's recipient_claimed re-pointing resolves it.
    subjectDid: params.recipientDid ?? params.issuerDid,
    type: 'payment_request.issued',
    contextId: params.paymentRequestId,
    contextType: 'payment_request',
    payload: {
      payment_request_id: params.paymentRequestId,
      kind: params.kind,
      recipient_did: params.recipientDid,
      recipient_stub_id: params.recipientStubId,
      total_amount: params.totalAmount,
      currency: params.currency,
      content_hash: params.contentHash,
    },
  });
}

/** Exactly ONE `payment_request.settled` per settlement, with `method`, signed by the asserting party (the issuer, for manual). */
export async function emitPaymentRequestSettledAttestation(params: {
  paymentRequestId: string;
  issuerDid: string;
  recipientDid: string | null;
  method: 'manual' | 'stripe' | 'mjnx';
  assertedBy: string;
  note?: string;
  contentHash: string;
  totalAmount: number;
  currency: string;
}): Promise<string | null> {
  return emitIssuerSignedAttestation({
    issuerDid: params.issuerDid,
    subjectDid: params.recipientDid ?? params.issuerDid,
    type: 'payment_request.settled',
    contextId: params.paymentRequestId,
    contextType: 'payment_request',
    payload: {
      payment_request_id: params.paymentRequestId,
      method: params.method,
      asserted_by: params.assertedBy,
      note: params.note ?? null,
      total_amount: params.totalAmount,
      currency: params.currency,
      content_hash: params.contentHash,
    },
  });
}

/**
 * Exactly ONE `payment_request.settled` per on-platform Stripe settlement
 * (#2209) — unlike the manual path above, this is KERNEL-signed (the
 * platform node identity, via the shared `emitMechanicalAttestation`
 * primitive), never the payment_request's issuer: the epic's "kernel
 * signs on-platform" requirement, since no human asserted this settlement
 * — the Stripe webhook did. Binds `content_hash` and the full
 * `settlement_ref` (checkout session id + payment intent id).
 */
export async function emitPaymentRequestSettledStripeAttestation(params: {
  paymentRequestId: string;
  issuerDid: string;
  recipientDid: string | null;
  contentHash: string;
  totalAmount: number;
  currency: string;
  settlementRef: PaymentRequestSettlementRef;
}): Promise<string | null> {
  return emitMechanicalAttestation({
    subjectDid: params.recipientDid ?? params.issuerDid,
    type: 'payment_request.settled',
    contextId: params.paymentRequestId,
    contextType: 'payment_request',
    payload: {
      payment_request_id: params.paymentRequestId,
      method: 'stripe',
      issuer_did: params.issuerDid,
      total_amount: params.totalAmount,
      currency: params.currency,
      content_hash: params.contentHash,
      settlement_ref: params.settlementRef,
    },
  });
}
