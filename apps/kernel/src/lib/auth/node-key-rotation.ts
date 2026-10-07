/**
 * Node signing-key rotation, kernel side (#2081).
 *
 * Two operations behind `POST/GET /api/admin/keys/rotation`, driven by
 * `scripts/key-rotation.mjs` (runbook: docs/security/node-key-roles-and-rotation.md):
 *
 *   - {@link recordKeyRotation} — file the node-issued `key.rotated`
 *     attestation. The operator signs the rotation statement with BOTH keys
 *     offline (`key-rotation.mjs sign`) and submits only the resulting public
 *     payload: no private key ever reaches this process beyond the one it
 *     already runs with, and the OLD key never needs to be loaded here after
 *     the env swap. The kernel re-verifies both signatures, checks the new key
 *     is the one it is actually signing with, and that the rotation extends
 *     the recorded history without a fork or a reused key.
 *   - {@link verifyNodeKeyHistory} — the machine check: load every live
 *     `key.rotated` this node issued, verify the dual signatures and the
 *     linear chain, and assert the chain ends at the key currently loaded.
 *   - {@link verifyNodeSignatureAcrossKeyHistory} — what makes old node-issued
 *     attestations stay verifiable after a rotation: accept a signature made
 *     by the key the verified history says was signing at `issuedAt`.
 *
 * The pure cryptography lives in `@imajin/auth` (`key-rotation.ts`); this
 * file only adds the node's DB and env.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  KEY_ROTATED_ATTESTATION_TYPE,
  KEY_ROTATED_CONTEXT_TYPE,
  computeKeyKid,
  crypto as authCrypto,
  trustedPublicKeysAt,
  verifyKeyRotatedPayload,
  verifyKeyRotationChain,
  type KeyHistoryEntry,
} from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { db, attestations, identities } from '@/src/db';
import { getNodeDid, resolveNodeDid, type NodeDidSource } from '@/src/lib/kernel/node-identity';
import { emitMechanicalAttestation } from './emit-mechanical-attestation';

const log = createLogger('kernel');

/** A rotation may not claim to take effect later than this past "now" — it is a record of a handover, not a schedule. */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type RecordKeyRotationResult =
  | { ok: true; attestationId: string; oldKid: string; newKid: string; effectiveAt: string }
  | { ok: false; status: 400 | 409 | 500; error: string };

function currentPublicKey(): string | null {
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) return null;
  try {
    return authCrypto.getPublicKey(privateKey);
  } catch {
    return null;
  }
}

/** Payloads of every live `key.rotated` this node has issued, oldest first. */
async function loadStoredRotationPayloads(nodeDid: string): Promise<unknown[]> {
  const rows = await db
    .select({ payload: attestations.payload })
    .from(attestations)
    .where(
      and(
        eq(attestations.issuerDid, nodeDid),
        eq(attestations.type, KEY_ROTATED_ATTESTATION_TYPE),
        isNull(attestations.revokedAt),
      ),
    )
    .orderBy(asc(attestations.issuedAt));
  return rows.map((row) => row.payload);
}

/**
 * `getNodeDid()` falls back to the `RELAY_DID` env var when
 * `relay.relay_config.imajin_did` is unset. That is the DFOS relay's identity,
 * not the node's: node-issued attestations would be filed under it, and the
 * runbook's `UPDATE auth.identities` would rewrite the relay identity's key.
 */
function relayDidFallbackMessage(did: string): string {
  return (
    `node DID ${did} was resolved from the RELAY_DID env fallback, not relay.relay_config.imajin_did — ` +
    'that is the relay identity, not the node identity. Set relay.relay_config.imajin_did (scripts/bootstrap-node-identity.ts) before rotating'
  );
}

/**
 * File the dual-signed `key.rotated` attestation for a rotation the operator
 * has already signed with both keys. Fails closed: every rejection is a
 * returned error with the HTTP status the admin route should answer with.
 */
export async function recordKeyRotation(input: unknown, now: Date = new Date()): Promise<RecordKeyRotationResult> {
  const verified = verifyKeyRotatedPayload(input);
  if (!verified.ok) return { ok: false, status: 400, error: verified.error };
  const { payload } = verified;

  const publicKey = currentPublicKey();
  if (!publicKey) {
    return { ok: false, status: 500, error: 'AUTH_PRIVATE_KEY is not set or is not a valid Ed25519 private key' };
  }
  if (payload.newPublicKey !== publicKey) {
    return {
      ok: false,
      status: 400,
      error: `newKid ${payload.newKid} is not the key this node is signing with (${computeKeyKid(publicKey)}) — swap AUTH_PRIVATE_KEY and restart before recording the rotation`,
    };
  }
  if (Date.parse(payload.effectiveAt) > now.getTime() + MAX_FUTURE_SKEW_MS) {
    return { ok: false, status: 400, error: 'effectiveAt is in the future — a rotation records a handover that has happened' };
  }

  const { did: nodeDid, source: nodeDidSource } = await resolveNodeDid();
  if (!nodeDid) {
    return { ok: false, status: 500, error: 'node DID is not configured — cannot file a node-issued attestation' };
  }
  if (nodeDidSource !== 'relay_config') {
    return { ok: false, status: 409, error: relayDidFallbackMessage(nodeDid) };
  }

  const stored = await loadStoredRotationPayloads(nodeDid);
  const existing = verifyKeyRotationChain(stored);
  if (!existing.ok) {
    return { ok: false, status: 409, error: `recorded key history is invalid: ${existing.error}` };
  }
  if (existing.keys.some((key) => key.kid === payload.newKid)) {
    return { ok: false, status: 409, error: `key ${payload.newKid} is already part of the recorded key history` };
  }
  const extended = verifyKeyRotationChain([...stored, payload]);
  if (!extended.ok) {
    return { ok: false, status: 409, error: `rotation does not extend the recorded key history: ${extended.error}` };
  }

  const attestationId = await emitMechanicalAttestation({
    subjectDid: nodeDid,
    type: KEY_ROTATED_ATTESTATION_TYPE,
    contextId: payload.newKid,
    contextType: KEY_ROTATED_CONTEXT_TYPE,
    payload: { ...payload },
  });
  if (!attestationId) {
    return { ok: false, status: 500, error: 'attestation could not be written (see kernel logs: signing or DB failure)' };
  }

  log.info({ attestationId, oldKid: payload.oldKid, newKid: payload.newKid }, 'key.rotated attestation minted');
  return { ok: true, attestationId, oldKid: payload.oldKid, newKid: payload.newKid, effectiveAt: payload.effectiveAt };
}

export interface NodeKeyHistoryReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  nodeDid: string | null;
  /** Where the node DID came from; anything but `relay_config` fails the check. */
  nodeDidSource: NodeDidSource;
  /** `kid` of the key currently in AUTH_PRIVATE_KEY, or null when unset/invalid. */
  currentKid: string | null;
  /** Number of live `key.rotated` attestations this node has issued. */
  rotations: number;
  /** The verified key history, oldest first; empty when no rotation has happened. */
  history: KeyHistoryEntry[];
}

/** Does the node's `identities` row carry the key it is signing with? Node-issued attestations resolve their issuer key from it. */
async function checkIdentityRow(
  nodeDid: string,
  publicKey: string,
): Promise<{ level: 'error' | 'warning'; message: string } | null> {
  const [identity] = await db
    .select({ publicKey: identities.publicKey })
    .from(identities)
    .where(eq(identities.id, nodeDid))
    .limit(1);
  if (!identity) {
    return { level: 'warning', message: `no identities row for node DID ${nodeDid} — node-issued attestations cannot be resolved to a key` };
  }
  if (identity.publicKey !== publicKey) {
    return {
      level: 'error',
      message: `identities.public_key for ${nodeDid} does not match AUTH_PRIVATE_KEY — node-issued attestations will not verify against the identity row`,
    };
  }
  return null;
}

/**
 * Verify the node's stored key history against the key currently loaded.
 *
 * Errors (fail the check): AUTH_PRIVATE_KEY missing/invalid, no node DID, a
 * broken/forked chain, a chain whose head is not the loaded key, a loaded
 * key that does not match the node identity row.
 * Warnings: no rotation recorded yet (fine on a never-rotated node).
 *
 * `anchorPublicKey` pins the chain's genesis — pass the key a verifier
 * pinned before the first rotation.
 */
export async function verifyNodeKeyHistory(options: { anchorPublicKey?: string } = {}): Promise<NodeKeyHistoryReport> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const publicKey = currentPublicKey();
  const currentKid = publicKey ? computeKeyKid(publicKey) : null;
  if (!publicKey) errors.push('AUTH_PRIVATE_KEY is not set or is not a valid Ed25519 private key');

  const resolved = await resolveNodeDid();
  const nodeDid = resolved.did || null;
  const nodeDidSource = resolved.source;
  if (!nodeDid) {
    errors.push('node DID is not configured (relay.relay_config.imajin_did)');
    return { ok: false, errors, warnings, nodeDid, nodeDidSource, currentKid, rotations: 0, history: [] };
  }
  if (nodeDidSource !== 'relay_config') errors.push(relayDidFallbackMessage(nodeDid));

  const stored = await loadStoredRotationPayloads(nodeDid);
  const chain = verifyKeyRotationChain(stored, { anchorPublicKey: options.anchorPublicKey });
  if (!chain.ok) {
    errors.push(`key history invalid: ${chain.error}`);
    return { ok: false, errors, warnings, nodeDid, nodeDidSource, currentKid, rotations: stored.length, history: [] };
  }

  if (chain.keys.length === 0) {
    warnings.push('no key.rotated attestation recorded — expected only on a node that has never rotated its key');
  } else if (currentKid && chain.currentKid !== currentKid) {
    errors.push(
      `key history ends at ${chain.currentKid} but AUTH_PRIVATE_KEY is ${currentKid} — the rotation was not attested (or the wrong key is loaded)`,
    );
  }

  if (publicKey) {
    const identityFinding = await checkIdentityRow(nodeDid, publicKey);
    if (identityFinding?.level === 'error') errors.push(identityFinding.message);
    else if (identityFinding) warnings.push(identityFinding.message);
  }

  return { ok: errors.length === 0, errors, warnings, nodeDid, nodeDidSource, currentKid, rotations: stored.length, history: chain.keys };
}

/**
 * Verify a signature the NODE made (issuer === this node's DID) against the
 * key history instead of only the current key — the fallback that keeps old
 * node-issued attestations verifiable after the key rotates.
 *
 * Only the key(s) the verified `key.rotated` chain says were signing at
 * `issuedAt` are tried, never every key ever seen. The history is trusted
 * only if it is a valid linear chain whose head is `currentPublicKey` (the key
 * the node identity row carries now): a chain that does not lead to the
 * current key proves nothing about it. Returns false for any other issuer, an
 * empty/invalid history, or a signature no in-window key made.
 */
export async function verifyNodeSignatureAcrossKeyHistory(params: {
  issuerDid: string;
  /** Public key the node identity row carries now — the history must end here. */
  currentPublicKey: string;
  signature: string;
  message: string;
  issuedAt: Date | number;
}): Promise<boolean> {
  const nodeDid = await getNodeDid();
  if (!nodeDid || params.issuerDid !== nodeDid) return false;

  const chain = verifyKeyRotationChain(await loadStoredRotationPayloads(nodeDid));
  if (!chain.ok || chain.keys.length === 0) return false;
  if (chain.keys.at(-1)?.publicKey !== params.currentPublicKey) return false;

  return trustedPublicKeysAt(chain.keys, params.issuedAt).some((publicKey) =>
    authCrypto.verifySync(params.signature, params.message, publicKey),
  );
}
