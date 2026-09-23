/**
 * Publisher DID signature verification for the kernel loop registry
 * (#2295, epic #2288/#2290 — "signed ingest").
 *
 * Copies the operator-approvals precedent exactly
 * (`apps/kernel/src/lib/notify/operator-countersign.ts`, #2082): resolve
 * the publishing agent's DID to its *current* single `identities.publicKey`
 * via `createDbResolver`, and require an exact match against the
 * `signature.keyId` the request carries, before verifying the Ed25519
 * signature over `canonicalize({ type, payload })`. That one rule
 * uniformly covers the three failure modes the ingest boundary must
 * reject:
 *   - unknown key — the DID doesn't resolve to any public key at all.
 *   - mismatched key — `keyId` doesn't equal the resolved key.
 *   - revoked/rotated key — the publisher rotated keys, so a signature
 *     from the old key no longer matches "current" either.
 *
 * Binding `type` into the signed fields (not just `payload`) matters here
 * specifically: without it, a signed `loop.started` envelope could be
 * replayed as `loop.finished` for the same `loopId` without forging
 * anything — the payload alone doesn't name which lifecycle phase it
 * asserts.
 */
import { createDbResolver, canonicalize, crypto as authCrypto } from '@imajin/auth';
import { db, identities } from '@/src/db';
import type { LoopEnvelope, LoopLifecycleType, LoopPublisherSignature } from './types';

export type VerifyLoopPublisherSignatureResult = { ok: true } | { ok: false; error: string };

/**
 * Verify a `signature` over `{ type, payload }` against the publisher DID's
 * currently registered key. Fails closed on any rejection path — never
 * throws, so the caller can map straight to a 400 without persisting or
 * publishing anything.
 */
export async function verifyLoopPublisherSignature(
  publisherDid: string,
  fields: { type: LoopLifecycleType; payload: LoopEnvelope },
  signature: LoopPublisherSignature,
): Promise<VerifyLoopPublisherSignatureResult> {
  if (signature.alg !== 'ed25519') {
    return { ok: false, error: 'Unsupported publisher signature algorithm' };
  }

  const resolver = createDbResolver(db, identities);
  const resolved = await resolver(publisherDid);
  if (!resolved?.publicKey) {
    return { ok: false, error: 'Could not resolve publisherDid to a registered public key' };
  }

  if (resolved.publicKey.toLowerCase() !== signature.keyId.toLowerCase()) {
    return {
      ok: false,
      error: "signature.keyId does not match publisherDid's current registered key (unknown or revoked key)",
    };
  }

  const canonical = canonicalize(fields);
  const valid = authCrypto.verifySync(signature.sig, canonical, resolved.publicKey);
  if (!valid) {
    return { ok: false, error: 'Invalid publisher signature' };
  }

  return { ok: true };
}
