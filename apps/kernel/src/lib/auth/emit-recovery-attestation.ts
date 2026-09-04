/**
 * Recovery attestations (#1250 Phase 1) — mechanical, system-class audit
 * records minted by the platform node identity, mirroring the pattern in
 * `emit-session-attestation.ts`. Never bilateral, never carrying an
 * `author_jws`.
 *
 * `recovery.codes.generated` records only a count — never the plaintext
 * codes, and not even the code hashes.
 * `recovery.redeemed` records that a recovery-authorized rotation happened.
 *
 * Both are fire-and-forget from the caller's perspective: a failure to emit
 * an attestation must never block the underlying generate/redeem operation.
 */
import { db, attestations } from '@/src/db';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import type { AttestationType } from '@imajin/auth';
import { computeCid } from '@imajin/cid';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { createLogger } from '@imajin/logger';
import { randomUUID } from 'node:crypto';

const log = createLogger('kernel');

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

async function emitRecoveryAttestation(params: {
  type: 'recovery.codes.generated' | 'recovery.redeemed';
  did: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    log.warn({}, `${params.type} attestation skipped: AUTH_PRIVATE_KEY not set`);
    return;
  }

  const platformDid = await getNodeDid();
  if (!platformDid) {
    log.warn({}, `${params.type} attestation skipped: node DID not set`);
    return;
  }

  const issuedAtMs = Date.now();
  const canonicalPayload = canonicalize({
    subject_did: params.did,
    type: params.type,
    context_id: null,
    context_type: 'auth',
    payload: params.payload,
    issued_at: issuedAtMs,
  });

  try {
    const signature = authCrypto.signSync(canonicalPayload, privateKey);

    let cid: string | null = null;
    try {
      cid = await computeCid({
        issuerDid: platformDid,
        subjectDid: params.did,
        type: params.type,
        contextId: null,
        contextType: 'auth',
        payload: params.payload,
        issuedAt: issuedAtMs,
      });
    } catch { /* non-fatal */ }

    await db.insert(attestations).values({
      id: genId('att'),
      issuerDid: platformDid,
      subjectDid: params.did,
      type: params.type as AttestationType,
      contextId: null,
      contextType: 'auth',
      payload: params.payload,
      signature,
      cid,
      // Mechanical audit record (#1822) — never bilateral/pending.
      attestationStatus: null,
      issuedAt: new Date(issuedAtMs),
    });
  } catch (err) {
    log.error({ err: String(err) }, `${params.type} attestation error`);
  }
}

/** Emit on every recovery-code (re)generation. Count only, never the codes. */
export async function emitRecoveryCodesGeneratedAttestation(params: { did: string; count: number }): Promise<void> {
  await emitRecoveryAttestation({
    type: 'recovery.codes.generated',
    did: params.did,
    payload: { count: params.count },
  });
}

/** Emit on a successful recovery-code redemption (key rotation). */
export async function emitRecoveryRedeemedAttestation(params: { did: string }): Promise<void> {
  await emitRecoveryAttestation({
    type: 'recovery.redeemed',
    did: params.did,
    payload: {},
  });
}
