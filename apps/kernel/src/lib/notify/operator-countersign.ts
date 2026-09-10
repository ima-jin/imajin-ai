/**
 * Operator countersignature verification (#2082).
 *
 * `operator.approval.decided` (#2059/#2078/#2152) was, until now, signed
 * only by the kernel's own node key (`getNodeSigningIdentity()` in
 * `operator-approvals-service.ts`) — a witness record of an authenticated
 * operator decision, not a decision the operator themselves cryptographically
 * stands behind. This module verifies a *second*, independent signature —
 * produced client-side on /jin with the operator's own key
 * (`apps/kernel/app/jin/operator-approvals-panel.tsx`) — over
 * `canonicalize({contentHash, decision, decidedAt})`.
 *
 * Key resolution deliberately mirrors the existing precedent in
 * `apps/kernel/src/lib/auth/witness-jws.ts` (used by the `attestations/
 * countersign` route): resolve the operator DID's *current* single
 * `identities.publicKey` via `createDbResolver`, and require an exact
 * match. That one rule uniformly covers three failure modes the ingest
 * boundary must reject:
 *   - unknown key — the DID doesn't resolve to any public key at all.
 *   - mismatched key — `keyId` doesn't equal the resolved key.
 *   - revoked/rotated key — the operator rotated keys (the existing
 *     `identity/:did/rotate` route updates `identities.publicKey`), so a
 *     signature from the old key no longer matches "current" either.
 * Multi-key/DFOS-chain-history-aware resolution (so a *former* key could
 * be distinguished from a key that was never valid) is #2081's separate,
 * not-yet-built follow-up — out of scope here, exactly as it is for
 * `witness-jws.ts` today.
 */
import { createDbResolver, canonicalize, crypto as authCrypto } from '@imajin/auth';
import { db, identities } from '@/src/db';
import type { OperatorCountersignFields, OperatorCountersignature } from './operator-approvals';

export type OperatorCountersignVerification = { ok: true } | { ok: false; error: string };

const ED25519_PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/i;
const ED25519_SIGNATURE_HEX = /^[0-9a-f]{128}$/i;

/**
 * Shape-validate an `operatorSignature` object parsed from an untrusted
 * request body. Purely structural — cryptographic verification is
 * {@link verifyOperatorCountersignature}, which requires a DB lookup and so
 * stays async and separate from this synchronous parse step.
 */
export function parseOperatorSignature(
  raw: unknown,
): { ok: true; value: OperatorCountersignature | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'operatorSignature must be an object' };
  }
  const { keyId, alg, sig } = raw as Record<string, unknown>;
  if (typeof keyId !== 'string' || !ED25519_PUBLIC_KEY_HEX.test(keyId)) {
    return { ok: false, error: 'operatorSignature.keyId must be a 64-char hex Ed25519 public key' };
  }
  if (alg !== 'ed25519') {
    return { ok: false, error: "operatorSignature.alg must be 'ed25519'" };
  }
  if (typeof sig !== 'string' || !ED25519_SIGNATURE_HEX.test(sig)) {
    return { ok: false, error: 'operatorSignature.sig must be a 128-char hex Ed25519 signature' };
  }
  return { ok: true, value: { keyId: keyId.toLowerCase(), alg, sig: sig.toLowerCase() } };
}

/**
 * Verify an `operatorSignature` over `{contentHash, decision, decidedAt}`
 * against the operator DID's currently registered key. Fails closed on any
 * rejection path — never throws, so the caller can map straight to a 400
 * without persisting anything.
 */
export async function verifyOperatorCountersignature(
  operatorDid: string,
  fields: OperatorCountersignFields,
  signature: OperatorCountersignature,
): Promise<OperatorCountersignVerification> {
  if (signature.alg !== 'ed25519') {
    return { ok: false, error: 'Unsupported operator signature algorithm' };
  }

  const resolver = createDbResolver(db, identities);
  const resolved = await resolver(operatorDid);
  if (!resolved?.publicKey) {
    return { ok: false, error: 'Could not resolve the operator DID to a registered public key' };
  }

  if (resolved.publicKey.toLowerCase() !== signature.keyId.toLowerCase()) {
    return {
      ok: false,
      error: "operatorSignature.keyId does not match the operator DID's current registered key (unknown or revoked key)",
    };
  }

  const canonical = canonicalize(fields);
  const valid = authCrypto.verifySync(signature.sig, canonical, resolved.publicKey);
  if (!valid) {
    return { ok: false, error: 'Invalid operator signature' };
  }

  return { ok: true };
}
