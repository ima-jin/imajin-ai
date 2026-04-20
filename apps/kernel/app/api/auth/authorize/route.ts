/**
 * POST /api/auth/authorize
 *
 * Creates an app.authorized attestation when a user consents to an app's access request.
 * Called by the consent UI (/auth/authorize).
 *
 * Body: { appId, scopes }
 * Returns: { attestationId }
 */

import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { db, attestations, registryApps } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth, validateScopes, canonicalize, crypto as authCrypto } from '@imajin/auth';
import { withLogger } from '@imajin/logger';

export const POST = withLogger('kernel', async (request: NextRequest) => {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { identity } = authResult;

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
      status: registryApps.status,
      requestedScopes: registryApps.requestedScopes,
      callbackUrl: registryApps.callbackUrl,
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
  const disallowed = validScopes.filter(s => !app.requestedScopes.includes(s));
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

  return NextResponse.json({ attestationId, userDid: identity.id }, { status: 201 });
});
