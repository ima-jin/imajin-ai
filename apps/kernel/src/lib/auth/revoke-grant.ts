import { and, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { db, attestations, oauthRefreshTokens, channelLinks } from '@/src/db';

/**
 * Canonical, user-initiated revoke for an integration grant (#1171).
 *
 * One entry point for "remove this integration's access to my DID," used by the
 * manage-access surface and (next) the #1170 consent UI's "disconnect."
 *
 * - `attestation` (OAuth / app-keypair grant): sign an app.revoked attestation,
 *   mark the app.authorized grant revoked, AND revoke the user's OAuth
 *   refresh-token chain for that grant (PR-1's #1171 5b behavior, shared here).
 * - `channel-link` (bot/messenger): deactivate the per-user link binding.
 *
 * Correction 4: this NEVER touches the shared `registry.apps` adapter row.
 * Revoking one owner's grant must not disable the client for every other owner.
 * Per-user bindings (`channel_links`, unique per (channel, channelUid, appDid))
 * are safe to deactivate; the shared OAuth adapter is not.
 */

export type GrantRef =
  | { kind: 'attestation'; attestationId: string }
  | { kind: 'channel-link'; id: string };

export type RevokeResult = { ok: true } | { ok: false; status: number; error: string };

export async function revokeGrant(ref: GrantRef, ownerDid: string): Promise<RevokeResult> {
  if (ref.kind === 'channel-link') {
    const [link] = await db.select().from(channelLinks).where(eq(channelLinks.id, ref.id)).limit(1);
    if (link?.did !== ownerDid) {
      return { ok: false, status: 404, error: 'Link not found' };
    }
    if (link.status !== 'revoked') {
      await db
        .update(channelLinks)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(eq(channelLinks.id, ref.id));
    }
    return { ok: true };
  }

  // attestation grant — must belong to this owner.
  const [original] = await db
    .select()
    .from(attestations)
    .where(
      and(
        eq(attestations.id, ref.attestationId),
        eq(attestations.issuerDid, ownerDid),
        eq(attestations.type, 'app.authorized'),
      ),
    )
    .limit(1);

  if (!original) {
    return { ok: false, status: 404, error: 'Authorization not found' };
  }

  const now = new Date();

  // Sign + record the revocation (skip if already revoked — idempotent).
  if (!original.revokedAt) {
    const privateKey = process.env.AUTH_PRIVATE_KEY;
    if (!privateKey) {
      return { ok: false, status: 500, error: 'Server misconfigured' };
    }
    const issuedAtMs = now.getTime();
    const payload = { revokedAttestationId: ref.attestationId, appDid: original.subjectDid };
    const signature = authCrypto.signSync(
      canonicalize({
        subject_did: original.subjectDid,
        type: 'app.revoked',
        context_id: ref.attestationId,
        context_type: 'attestation',
        payload,
        issued_at: issuedAtMs,
      }),
      privateKey,
    );
    await db.insert(attestations).values({
      id: `att_${nanoid(16)}`,
      issuerDid: ownerDid,
      subjectDid: original.subjectDid,
      type: 'app.revoked',
      contextId: ref.attestationId,
      contextType: 'attestation',
      payload,
      signature,
      issuedAt: now,
    });
    await db.update(attestations).set({ revokedAt: now }).where(eq(attestations.id, ref.attestationId));
  }

  // Revoke this user's OAuth refresh-token chain for the grant (#1171 5b).
  // Per-user scoped via attestationId; never touches registry.apps.
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthRefreshTokens.attestationId, ref.attestationId), isNull(oauthRefreshTokens.revokedAt)));

  return { ok: true };
}
