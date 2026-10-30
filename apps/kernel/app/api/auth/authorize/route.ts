/**
 * POST /api/auth/authorize
 *
 * Creates an app.authorized attestation when a user consents to an app's access request.
 * Called by the consent UI (/auth/authorize).
 *
 * Body: { appId, scopes, state }
 * Returns: { redirect } containing a short-lived code and the supplied state.
 * Invalid app callbacks must be rejected before consent is persisted (#3162).
 * #3008: consent must converge to one live grant per (principal, app).
 *
 * Re-consent (#3008): identical scope sets reuse the newest live grant;
 * changed scopes supersede every live grant. The shared upsert serializes
 * each principal/app pair and signs every surplus revocation atomically
 * with the surviving grant's channel_links projection.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, registryApps } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth, validateScopes, resolveActingDid } from '@imajin/auth';
import { withLogger } from '@imajin/logger';
import { promoteActorOnGrant } from '@/src/lib/auth/promote-actor';
import { upsertAppAuthorization } from '@/src/lib/auth/upsert-app-authorization';
import { addConsentedApp } from '@/src/lib/kernel/app-membership';
import { canConsentToApp, PRIVATE_APP_CONSENT_ERROR } from '@/src/lib/kernel/app-consent';
import { issueAppAuthorizationCode } from '@/src/lib/auth/app-authorization-code';

export const dynamic = 'force-dynamic';

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

  const { appId, scopes, state } = (body ?? {}) as { appId?: string; scopes?: string[]; state?: string };

  if (!appId || typeof appId !== 'string') {
    return NextResponse.json({ error: 'appId is required' }, { status: 400 });
  }
  if (!Array.isArray(scopes)) {
    return NextResponse.json({ error: 'scopes must be an array' }, { status: 400 });
  }
  if (typeof state !== 'string' || state.length < 32 || state.length > 256) {
    return NextResponse.json({ error: 'state must be 32 to 256 characters' }, { status: 400 });
  }

  // Load app
  const [app] = await db
    .select({
      id: registryApps.id,
      slug: registryApps.slug,
      appDid: registryApps.appDid,
      publicKey: registryApps.publicKey,
      status: registryApps.status,
      requestedScopes: registryApps.requestedScopes,
      callbackUrl: registryApps.callbackUrl,
      name: registryApps.name,
      logoUrl: registryApps.logoUrl,
      visibility: registryApps.visibility,
      ownerDid: registryApps.ownerDid,
      signInAudience: registryApps.signInAudience,
    })
    .from(registryApps)
    .where(eq(registryApps.id, appId));

  if (!app) {
    return NextResponse.json({ error: 'App not found' }, { status: 404 });
  }
  if (app.status !== 'active') {
    return NextResponse.json({ error: 'App is revoked' }, { status: 403 });
  }
  if (!await canConsentToApp(app, identity.id)) {
    return NextResponse.json({ error: PRIVATE_APP_CONSENT_ERROR }, { status: 403 });
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
  let redirect: URL;
  try {
    redirect = new URL(app.callbackUrl);
  } catch {
    return NextResponse.json({ error: 'invalid_app_callback' }, { status: 400 });
  }

  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const attestationId = await upsertAppAuthorization({
    ownerDid: identity.id, appDid: app.appDid, appId: app.id,
    callbackUrl: app.callbackUrl, scopes: validScopes, privateKey,
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

  await addConsentedApp(identity.id, app.slug);

  const code = await issueAppAuthorizationCode({
    appDid: app.appDid, subjectDid: identity.id, attestationId,
    callbackUrl: app.callbackUrl, state,
  });
  redirect.searchParams.delete('attestation_id');
  redirect.searchParams.delete('user_did');
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', state);
  return NextResponse.json({ redirect: redirect.toString() }, {
    status: 201, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
});
