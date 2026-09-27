/**
 * `Authorization: DFOS <proof>` verification for relay writes (#2132).
 *
 * Ruling (2026-09-26): relay writes accept the DFOS protocol's own
 * DID-signed proof scheme, verified per protocol 0.2.0, **for attested
 * peers only** — a cryptographically valid proof alone never admits. The
 * admission gate itself lives in `./peer-attestations`; this module only
 * verifies the proof and extracts the peer DID.
 *
 * `<proof>` is a DFOS auth-token JWT — the same self-certifying primitive
 * `@metalabel/dfos-web-relay` verifies for its own (Bearer-scheme) relay
 * AuthN: a JWS signed by one of the peer identity's current auth keys,
 * whose payload asserts `iss` (the peer DID) and `aud` (this relay's own
 * DFOS DID), verified via `@metalabel/dfos-protocol`'s `verifyAuthToken`.
 */
import { decodeJwsUnsafe } from '@metalabel/dfos-protocol/crypto';
import { decodeMultikey } from '@metalabel/dfos-protocol/chain';
import { verifyAuthToken } from '@metalabel/dfos-protocol/credentials';
import { createLogger } from '@imajin/logger';
import { isRelayPeerAttested } from './peer-attestations';

const log = createLogger('kernel');

/** The `Authorization` scheme this module recognizes. */
export const DFOS_AUTH_SCHEME = 'DFOS';

/** A DID's current auth keys, in the shape `@metalabel/dfos-protocol`'s `VerifiedIdentity` exposes them. */
export interface RelayAuthKey {
  id: string;
  publicKeyMultibase: string;
}

/**
 * Resolves the current auth keys for a DFOS DID as known to this relay's
 * own store — the `did:dfos` counterpart of `@imajin/auth`'s identity
 * resolution, scoped to what `RelayStore.getIdentityChain` already holds.
 */
export interface RelayIdentityResolver {
  resolveAuthKeys(did: string): Promise<RelayAuthKey[] | undefined>;
}

export interface DfosWriteAuthDeps {
  identities: RelayIdentityResolver;
  /** Resolves this relay's own DFOS DID (the proof's expected audience). Lazy — only called for DFOS-scheme requests. */
  getAudience(): Promise<string | null>;
}

interface DfosProofVerified {
  ok: true;
  did: string;
}

interface DfosProofRejected {
  ok: false;
  error: string;
  status: 401 | 403;
}

export type DfosProofResult = DfosProofVerified | DfosProofRejected;

/** Every cryptographic-verification failure collapses to this single 401 shape (see {@link verifyDfosWrite}'s docblock for why). */
const INVALID_PROOF: DfosProofRejected = { ok: false, error: 'invalid_proof', status: 401 };

/**
 * Extract the proof from an `Authorization: DFOS <proof>` header.
 * Returns `null` for a missing header or any other scheme — the caller
 * falls through to the existing Imajin auth path unchanged.
 */
export function parseDfosAuthorization(header: string | null): string | null {
  if (!header) return null;
  const spaceIndex = header.indexOf(' ');
  if (spaceIndex <= 0) return null;
  const scheme = header.slice(0, spaceIndex);
  if (scheme !== DFOS_AUTH_SCHEME) return null;
  const proof = header.slice(spaceIndex + 1).trim();
  return proof.length > 0 ? proof : null;
}

interface ResolvedSigningKey {
  did: string;
  publicKey: Uint8Array;
}

/** Resolve the raw Ed25519 public key for a JWS `kid` (`did:dfos:xxx#key_yyy`) from the peer's current auth keys. */
async function resolveSigningKey(
  kid: string,
  identities: RelayIdentityResolver,
): Promise<ResolvedSigningKey | null> {
  const hashIndex = kid.indexOf('#');
  if (hashIndex <= 0) return null;
  const did = kid.slice(0, hashIndex);
  const keyId = kid.slice(hashIndex + 1);

  const authKeys = await identities.resolveAuthKeys(did);
  const key = authKeys?.find((candidate) => candidate.id === keyId);
  if (!key) return null;

  try {
    const { keyBytes } = decodeMultikey(key.publicKeyMultibase);
    return { did, publicKey: keyBytes };
  } catch {
    return null;
  }
}

/** Verify the DFOS auth-token JWS itself — signature, expiry, audience. Never throws. */
function verifyProofSignature(
  proof: string,
  key: ResolvedSigningKey,
  audience: string,
): { ok: true } | { ok: false } {
  try {
    const verified = verifyAuthToken({ token: proof, publicKey: key.publicKey, audience });
    return verified.iss === key.did ? { ok: true } : { ok: false };
  } catch (err) {
    log.warn({ err: String(err) }, '[relay] DFOS proof signature verification failed');
    return { ok: false };
  }
}

/**
 * Verify an `Authorization: DFOS <proof>` write credential end to end.
 *
 * Any failure to cryptographically verify the proof — malformed token,
 * unknown signer, bad signature, wrong audience, expired — is a 401
 * `invalid_proof`. We cannot distinguish "unknown peer" from "forged
 * proof" without first trusting the signature, so per the #2132
 * acceptance criteria this always wins over attestation status: an
 * unattested DID never surfaces as 403 unless its proof verified first.
 *
 * A cryptographically valid proof from a DID with no live `relay.peer`
 * attestation is a 403 `peer_not_attested` — the dark-forest default: a
 * valid proof alone does not admit.
 */
export async function verifyDfosWrite(proof: string, deps: DfosWriteAuthDeps): Promise<DfosProofResult> {
  const decoded = decodeJwsUnsafe(proof);
  const kid = decoded?.header.kid;
  if (!kid) {
    return INVALID_PROOF;
  }

  // This relay has no DFOS identity of its own yet — no proof can name it
  // as an audience, so every DFOS-scheme write fails closed.
  const audience = await deps.getAudience();
  if (!audience) {
    return INVALID_PROOF;
  }

  const key = await resolveSigningKey(kid, deps.identities);
  if (!key) {
    return INVALID_PROOF;
  }

  const verification = verifyProofSignature(proof, key, audience);
  if (!verification.ok) {
    return INVALID_PROOF;
  }

  const attested = await isRelayPeerAttested(key.did);
  if (!attested) {
    return { ok: false, error: 'peer_not_attested', status: 403 };
  }

  return { ok: true, did: key.did };
}
