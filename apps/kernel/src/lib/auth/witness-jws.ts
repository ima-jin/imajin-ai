/**
 * witnessJws verification (#2083) — the countersign route used to accept
 * `witnessJws` and persist it without ever checking the signature or that
 * it binds to the attestation being countersigned. Real verification:
 *
 * 1. `alg` allow-list — only `EdDSA` (the only algorithm identities in this
 *    system sign with, see `@imajin/auth`'s crypto module) is accepted;
 *    `none` and everything else is rejected before any key material is
 *    touched.
 * 2. Signature — verified against the witness DID's *currently resolved*
 *    public key via `createDbResolver` (`@imajin/auth`), the same
 *    DB-backed DID resolution `settle-core.ts`'s manifest-signature check
 *    already uses. Key-history-aware resolution for rotated witness keys
 *    is #2081's follow-up — out of scope here.
 * 3. CID binding — the JWS payload must name this exact attestation's id
 *    and CID, so a validly-signed JWS for a *different* countersign can
 *    never be replayed onto this one.
 *
 * Fails closed throughout: every rejection path returns `{ ok: false }`
 * with a reason, never throws, so the route can map any failure straight
 * to a 422 without persisting anything.
 */
import * as jose from 'jose';
import { createDbResolver } from '@imajin/auth';
import { db, identities } from '@/src/db';

/** The only JWS algorithm identities in this system sign with (see @imajin/auth/crypto — Ed25519). */
const ALLOWED_JWS_ALGORITHMS = ['EdDSA'];

export type WitnessJwsVerificationResult = { ok: true } | { ok: false; error: string };

interface WitnessJwsPayload {
  attestationId?: unknown;
  cid?: unknown;
}

function parseWitnessPayload(bytes: Uint8Array): WitnessJwsPayload | null {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as WitnessJwsPayload;
  } catch {
    return null;
  }
}

async function resolveWitnessPublicKey(witnessDid: string): Promise<string | null> {
  const resolver = createDbResolver(db, identities);
  const identity = await resolver(witnessDid);
  return identity?.publicKey ?? null;
}

/**
 * Verify a countersign's `witnessJws`: real Ed25519/EdDSA signature by the
 * witness DID's resolved key, over a payload that names this exact
 * attestation's id + CID.
 */
export async function verifyWitnessJws(params: {
  witnessJws: string;
  witnessDid: string;
  attestationId: string;
  cid: string | null;
}): Promise<WitnessJwsVerificationResult> {
  const { witnessJws, witnessDid, attestationId, cid } = params;

  let header: jose.ProtectedHeaderParameters;
  try {
    header = jose.decodeProtectedHeader(witnessJws);
  } catch {
    return { ok: false, error: 'witnessJws is not a well-formed JWS' };
  }

  if (typeof header.alg !== 'string' || !ALLOWED_JWS_ALGORITHMS.includes(header.alg)) {
    return { ok: false, error: `witnessJws alg "${header.alg ?? 'none'}" is not allowed` };
  }

  if (!cid) {
    return { ok: false, error: 'Attestation has no CID to verify witnessJws against' };
  }

  const witnessPublicKeyHex = await resolveWitnessPublicKey(witnessDid);
  if (!witnessPublicKeyHex) {
    return { ok: false, error: `Could not resolve witness DID "${witnessDid}"` };
  }

  let verifiedPayload: Uint8Array;
  try {
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: jose.base64url.encode(Buffer.from(witnessPublicKeyHex, 'hex')) };
    const publicKey = await jose.importJWK(jwk, 'EdDSA');
    const result = await jose.compactVerify(witnessJws, publicKey, { algorithms: ALLOWED_JWS_ALGORITHMS });
    verifiedPayload = result.payload;
  } catch {
    return { ok: false, error: 'Invalid witnessJws signature' };
  }

  const payload = parseWitnessPayload(verifiedPayload);
  if (!payload || payload.attestationId !== attestationId || payload.cid !== cid) {
    return { ok: false, error: 'witnessJws payload does not bind to this attestation (attestationId/cid mismatch)' };
  }

  return { ok: true };
}
