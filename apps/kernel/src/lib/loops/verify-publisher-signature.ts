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
 *
 * ## Node-signed publishers (#2338)
 * The kernel node itself publishes `warp.run` -> `loop.*` events
 * (`apps/kernel/src/lib/warp/loop-emit.ts`) signed with its own vault
 * sealing identity (`getNodeSigningIdentity()`,
 * `apps/kernel/src/lib/vault/sealing.ts`). That identity's `senderDid` is
 * derived from its own pubkey and is intentionally never written to the
 * identity registry (it exists purely to sign/verify the node's own vault
 * entries) — so `createDbResolver` can never resolve it, and every
 * node-signed loop event was rejected in production with "Could not
 * resolve publisherDid to a registered public key".
 *
 * The fix is an in-process resolver: when `publisherDid` equals the
 * node's own signing DID, verify directly against
 * `getNodeSigningIdentity().senderPubkey` — no registry round-trip, since
 * the node verifying its own key can't depend on a registry write having
 * succeeded. Every other publisher still resolves through the registry
 * exactly as before.
 */
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { createDbResolver } from '@imajin/auth/resolve-db';
import { db, identities } from '@/src/db';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import type { LoopEnvelope, LoopLifecycleType, LoopPublisherSignature } from './types';

export type VerifyLoopPublisherSignatureResult = { ok: true } | { ok: false; error: string };

/**
 * Resolve `publisherDid` to its current public key. The kernel node's own
 * signing DID (`getNodeSigningIdentity().senderDid`) resolves in-process
 * against its own derived pubkey — it is never registered, by design (see
 * module doc) — every other DID still resolves via the identity registry.
 */
async function resolvePublisherPublicKey(publisherDid: string): Promise<string | undefined> {
  const nodeIdentity = getNodeSigningIdentity();
  if (publisherDid === nodeIdentity.senderDid) {
    return nodeIdentity.senderPubkey;
  }

  const resolver = createDbResolver(db, identities);
  const resolved = await resolver(publisherDid);
  return resolved?.publicKey;
}

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

  const publicKey = await resolvePublisherPublicKey(publisherDid);
  if (!publicKey) {
    return { ok: false, error: 'Could not resolve publisherDid to a registered public key' };
  }

  if (publicKey.toLowerCase() !== signature.keyId.toLowerCase()) {
    return {
      ok: false,
      error: "signature.keyId does not match publisherDid's current registered key (unknown or revoked key)",
    };
  }

  const canonical = canonicalize(fields);
  const valid = authCrypto.verifySync(signature.sig, canonical, publicKey);
  if (!valid) {
    return { ok: false, error: 'Invalid publisher signature' };
  }

  return { ok: true };
}
