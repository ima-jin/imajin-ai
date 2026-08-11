/**
 * POST /api/auth/authorize
 *
 * Creates an app.authorized attestation when a user consents to an app's access request.
 * Called by the consent UI (/auth/authorize).
 *
 * Body: { appId, scopes }
 * Returns: { attestationId }
 *
 * Re-consent (#1795): when the caller already holds an active grant for this
 * app, an identical scope set reuses that attestation (no churn on duplicate
 * submits); a changed scope set supersedes it — the old attestation is
 * revoked exactly once (via the same compare-and-swap helper the explicit
 * disconnect flow uses), then a fresh attestation is minted and its id
 * returned so the caller's session picks up the new grant.
 */

import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { db, attestations, registryApps } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth, validateScopes, canonicalize, crypto as authCrypto, resolveActingDid } from '@imajin/auth';
import { withLogger } from '@imajin/logger';
import { promoteActorOnGrant } from '@/src/lib/auth/promote-actor';
import { revokeAttestationOnce } from '@/src/lib/auth/revoke-attestation';
import { projectAppAuthorizationGrant } from '@/src/lib/auth/app-authorization-grant';

function sameScopeSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => x.localeCompare(y));
  const sortedB = [...b].sort((x, y) => x.localeCompare(y));
  return sortedA.every((s, i) => s === sortedB[i]);
}

export const POST = withLogger('kernel', async (request: NextRequest) => {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { identity } = authResult;
  // #1735: the promoted actor must belong to the acting/business DID, not the
  // caller's raw session DID, when consent is granted while acting on behalf
  // of a business/app identity.
  const ownerDid = resolveActingDid(identity);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { appId, scopes } = body as { appId?: string; scopes?: string[] };

  if (!appId || typeof appId !== 'string') {
    return NextResponse.json({ error: 'appId is required' }, { status: 400 });
  }
  if (!Array.isArray(scopes)) {
    return NextResponse.json({ error: 'scopes must be an array' }, { status: 400 });
  }

  // Load app
  const [app] = await db
    .select({
      id: registryApps.id,
      appDid: registryApps.appDid,
      publicKey: registryApps.publicKey,
      status: registryApps.status,
      requestedScopes: registryApps.requestedScopes,
      callbackUrl: registryApps.callbackUrl,
      name: registryApps.name,
      logoUrl: registryApps.logoUrl,
    })
    .from(registryApps)
    .where(eq(registryApps.id, appId));

  if (!app) {
    return NextResponse.json({ error: 'App not found' }, { status: 404 });
  }
  if (app.status !== 'active') {
    return NextResponse.json({ error: 'App is revoked' }, { status: 403 });
  }

  // Validate requested scopes against app's registered scopes
  const { valid: validScopes, invalid: invalidScopes } = validateScopes(scopes);
  const disallowed = validScopes.filter(s => !(app.requestedScopes ?? []).includes(s));
  if (invalidScopes.length > 0) {
    return NextResponse.json({ error: `Unknown scopes: ${invalidScopes.join(', ')}` }, { status: 400 });
  }
  if (disallowed.length > 0) {
    return NextResponse.json({ error: `Scopes not registered by app: ${disallowed.join(', ')}` }, { status: 400 });
  }

  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // Re-consent: look for an active grant already on file for this (user, app).
  const [existing] = await db
    .select({ id: attestations.id, payload: attestations.payload })
    .from(attestations)
    .where(
      and(
        eq(attestations.issuerDid, identity.id),
        eq(attestations.subjectDid, app.appDid),
        eq(attestations.type, 'app.authorized'),
        isNull(attestations.revokedAt),
      )
    );

  if (existing) {
    const existingScopes = (existing.payload as { scopes?: string[] } | null)?.scopes ?? [];
    if (sameScopeSet(existingScopes, validScopes)) {
      // Nothing changed — reuse the existing grant rather than churning the
      // attestation id (and, downstream, every cached token/session).
      await promoteActorOnGrant({
        appId: app.id,
        appDid: app.appDid,
        publicKey: app.publicKey,
        ownerDid,
        name: app.name,
        avatarUrl: app.logoUrl,
        adapter: 'keypair',
      });
      // Re-affirm the channel_links projection (#1803) even on a no-op
      // re-submit, so a grant that was manually revoked out-of-band gets
      // re-materialised alongside the attestation it is derived from.
      await projectAppAuthorizationGrant({ ownerDid: identity.id, appDid: app.appDid, scopes: validScopes });
      return NextResponse.json({ attestationId: existing.id, userDid: identity.id }, { status: 201 });
    }

    // Scopes changed — supersede: revoke the old grant exactly once before
    // minting the replacement. If a concurrent request already won this race
    // (revoked === false), we still proceed to mint the new attestation below
    // — the caller's intent (grant the updated scope set) still holds.
    await revokeAttestationOnce({
      attestationId: existing.id,
      revokedByDid: identity.id,
      privateKey,
    });
  }

  const issuedAtMs = Date.now();
  const payload = { scopes: validScopes, appId: app.id, callbackUrl: app.callbackUrl };

  const canonicalPayload = canonicalize({
    subject_did: app.appDid,
    type: 'app.authorized',
    context_id: app.id,
    context_type: 'app',
    payload,
    issued_at: issuedAtMs,
  });

  const signature = authCrypto.signSync(canonicalPayload, privateKey);
  const attestationId = `att_${nanoid(16)}`;

  await db.insert(attestations).values({
    id: attestationId,
    issuerDid: identity.id,
    subjectDid: app.appDid,
    type: 'app.authorized',
    contextId: app.id,
    contextType: 'app',
    payload,
    signature,
    issuedAt: new Date(issuedAtMs),
  });

  // Promote the authorized app into a first-class actor identity in the graph
  // (#1170), storing its real Ed25519 public key and linking it to the acting
  // DID via identity_members (#1735). Idempotent + non-fatal; the attestation
  // above is the grant of record.
  await promoteActorOnGrant({
    appId: app.id,
    appDid: app.appDid,
    publicKey: app.publicKey,
    ownerDid,
    name: app.name,
    avatarUrl: app.logoUrl,
    adapter: 'keypair',
  });

  // Project the just-granted scopes into auth.channel_links (#1803): the
  // OAuth authorize/consent screen the user just completed IS the consent
  // event for the selective-disclosure pipeline — no separate consent
  // surface is needed. Attributed to the signing identity (identity.id),
  // matching the attestation's issuerDid and what ends up as `sub` on every
  // app token minted against this grant.
  await projectAppAuthorizationGrant({ ownerDid: identity.id, appDid: app.appDid, scopes: validScopes });

  return NextResponse.json({ attestationId, userDid: identity.id }, { status: 201 });
});
