/**
 * Shared, race-safe revocation for `app.authorized` attestations (#1795).
 */
import { nanoid } from 'nanoid';
import { and, eq, isNull, ne } from 'drizzle-orm';
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
 *
 * `ne(attestationStatus, 'bilateral')` (#1790) is an explicit guard, not an
 * absence-based one: today this route is hard-scoped to `app.authorized`
 * attestations, which never reach `bilateral` in practice, so the guard is
 * a no-op in the current call graph. It exists so a future change that
 * generalizes this CAS beyond `app.authorized` (or a future caller that
 * reuses it) can't silently revoke a bilateral record out from under the
 * amendment-by-supersession flow — bilateral attestations must stay immune
 * to unilateral revoke/cancel by construction, not by coincidence.
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
    .where(
      and(
        eq(attestations.id, attestationId),
        isNull(attestations.revokedAt),
        ne(attestations.attestationStatus, 'bilateral'),
      ),
    )
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
