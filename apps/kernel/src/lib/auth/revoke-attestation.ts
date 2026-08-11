/**
 * Shared, race-safe revocation for `app.authorized` attestations (#1795).
 */
import { nanoid } from 'nanoid';
import { and, eq, isNull } from 'drizzle-orm';
import { db, attestations, oauthRefreshTokens } from '@/src/db';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';

export interface RevokeAttestationResult {
  revoked: boolean;
  subjectDid?: string;
}

/**
 * Atomically revoke an `app.authorized` attestation and record an
 * `app.revoked` attestation as proof — exactly once.
 *
 * The UPDATE's WHERE clause (`id` + `revokedAt IS NULL`) is a compare-and-swap:
 * only the request that flips `revokedAt` from null proceeds to sign and insert
 * the `app.revoked` record. Every other caller sees `revoked: false` and
 * performs no revocation-attestation write.
 */
export async function revokeAttestationOnce(params: {
  attestationId: string;
  revokedByDid: string;
  privateKey: string;
}): Promise<RevokeAttestationResult> {
  const { attestationId, revokedByDid, privateKey } = params;
  const issuedAtMs = Date.now();

  const claimed = await db
    .update(attestations)
    .set({ revokedAt: new Date(issuedAtMs) })
    .where(and(eq(attestations.id, attestationId), isNull(attestations.revokedAt)))
    .returning({ subjectDid: attestations.subjectDid });

  if (claimed.length === 0) {
    return { revoked: false };
  }

  const subjectDid = claimed[0].subjectDid;
  const payload = { revokedAttestationId: attestationId, appDid: subjectDid };

  const canonicalPayload = canonicalize({
    subject_did: subjectDid,
    type: 'app.revoked',
    context_id: attestationId,
    context_type: 'attestation',
    payload,
    issued_at: issuedAtMs,
  });

  const signature = authCrypto.signSync(canonicalPayload, privateKey);

  await db.insert(attestations).values({
    id: `att_${nanoid(16)}`,
    issuerDid: revokedByDid,
    subjectDid,
    type: 'app.revoked',
    contextId: attestationId,
    contextType: 'attestation',
    payload,
    signature,
    issuedAt: new Date(issuedAtMs),
  });

  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: new Date(issuedAtMs) })
    .where(
      and(
        eq(oauthRefreshTokens.attestationId, attestationId),
        isNull(oauthRefreshTokens.revokedAt),
      )
    );

  return { revoked: true, subjectDid };
}
