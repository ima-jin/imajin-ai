import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { eq, and } from 'drizzle-orm';
import { db, registryApps, attestations, oauthAuthorizationCodes } from '@/src/db';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { getEffectiveDid } from '@/app/auth/lib/get-effective-did';
import { createLogger } from '@imajin/logger';
import { rateLimit, getClientIP } from '@imajin/config';
import {
  MCP_RESOURCE,
  AUTHORIZATION_CODE_TTL_MS,
  filterGrantedScopes,
  generateOpaqueToken,
  hashToken,
} from '@/src/lib/mcp/oauth-config';

const log = createLogger('kernel');
export const dynamic = 'force-dynamic';

/** Redirect back to the client with OAuth error params (RFC 6749 §4.1.2.1). */
function errorRedirect(redirectUri: string, state: string | null, error: string, description?: string) {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return NextResponse.redirect(url);
}

/**
 * GET /oauth/authorize — OAuth 2.1 authorization endpoint (public client + PKCE).
 *
 * Flow: validate client + redirect_uri (allowlist) → validate PKCE/scope params →
 * require a logged-in DID session → record consent as an app.authorized
 * attestation → mint a single-use, PKCE-bound authorization code → 302 back to
 * the client with ?code&state.
 */
export async function GET(request: NextRequest) {
  // Rate-limit this public endpoint (per-IP now; per-client once client_id known).
  const ip = getClientIP(request);
  const ipLimit = rateLimit(`oauth-authorize:ip:${ip}`, 60, 60_000);
  if (ipLimit.limited) {
    return new NextResponse('Too Many Requests', { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfter) } });
  }

  const { searchParams } = new URL(request.url);
  const responseType = searchParams.get('response_type');
  const clientId = searchParams.get('client_id');
  const redirectUri = searchParams.get('redirect_uri');
  const scopeParam = searchParams.get('scope');
  const state = searchParams.get('state');
  const codeChallenge = searchParams.get('code_challenge');
  const codeChallengeMethod = searchParams.get('code_challenge_method');
  const resource = searchParams.get('resource'); // RFC 8707 (optional)

  // 1. Resolve + validate the pre-registered client BEFORE trusting redirect_uri.
  if (!clientId) {
    return NextResponse.json({ error: 'invalid_request', error_description: 'client_id required' }, { status: 400 });
  }
  const clientLimit = rateLimit(`oauth-authorize:client:${clientId}`, 120, 60_000);
  if (clientLimit.limited) {
    return new NextResponse('Too Many Requests', { status: 429, headers: { 'Retry-After': String(clientLimit.retryAfter) } });
  }
  const [client] = await db
    .select({
      id: registryApps.id,
      appDid: registryApps.appDid,
      callbackUrl: registryApps.callbackUrl,
      status: registryApps.status,
      requestedScopes: registryApps.requestedScopes,
    })
    .from(registryApps)
    .where(eq(registryApps.id, clientId))
    .limit(1);

  if (!client || client.status !== 'active') {
    return NextResponse.json({ error: 'unauthorized_client', error_description: 'Unknown or inactive client' }, { status: 400 });
  }

  // 2. Exact redirect_uri allowlist match — no prefix/substring matching.
  //    (Pre-registered: Claude's callback is https://claude.ai/api/mcp/auth_callback.)
  if (!redirectUri || redirectUri !== client.callbackUrl) {
    return NextResponse.json({ error: 'invalid_request', error_description: 'redirect_uri mismatch' }, { status: 400 });
  }

  // --- redirect_uri is now trusted: surface further errors via redirect. ---

  if (responseType !== 'code') {
    return errorRedirect(redirectUri, state, 'unsupported_response_type');
  }
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    return errorRedirect(redirectUri, state, 'invalid_request', 'PKCE code_challenge with S256 required');
  }
  if (resource && resource !== MCP_RESOURCE) {
    return errorRedirect(redirectUri, state, 'invalid_target', 'unknown resource');
  }

  // 3. Scope = requested ∩ MCP-supported ∩ client-registered.
  const registered = new Set(client.requestedScopes ?? []);
  const granted = filterGrantedScopes(scopeParam).filter((s) => registered.has(s));
  if (granted.length === 0) {
    return errorRedirect(redirectUri, state, 'invalid_scope');
  }
  const scope = granted.join(' ');

  // 4. Require a logged-in DID session. Use the real SESSION DID (not the
  //    acting-as / acting-for effective DID) as the resource owner, so a
  //    connector can never be minted against a group the user is impersonating.
  const { sessionDid } = await getEffectiveDid();
  if (!sessionDid) {
    const loginUrl = new URL('/auth/login', request.url);
    loginUrl.searchParams.set('next', request.url); // return to /authorize after login
    return NextResponse.redirect(loginUrl);
  }

  // 5. Consent → app.authorized attestation (this is the grant the revoke story
  //    reads: /auth/apps lists it, /api/auth/revoke revokes it). Reuse an active
  //    grant if one already exists for this (user, app).
  //    TODO(consent-ui): render an explicit scope-consent screen before this step
  //    instead of implicit first-party consent.
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    return errorRedirect(redirectUri, state, 'server_error', 'signing key unavailable');
  }

  let attestationId: string;
  const [existing] = await db
    .select({ id: attestations.id, revokedAt: attestations.revokedAt })
    .from(attestations)
    .where(and(
      eq(attestations.issuerDid, sessionDid),
      eq(attestations.subjectDid, client.appDid),
      eq(attestations.type, 'app.authorized'),
    ))
    .limit(1);

  if (existing && !existing.revokedAt) {
    attestationId = existing.id;
    // TODO: if existing payload.scopes ⊉ granted, widen (re-sign) or re-consent.
  } else {
    const issuedAtMs = Date.now();
    const payload = { scopes: granted, appId: client.id, callbackUrl: client.callbackUrl };
    const signature = authCrypto.signSync(
      canonicalize({
        subject_did: client.appDid,
        type: 'app.authorized',
        context_id: client.id,
        context_type: 'app',
        payload,
        issued_at: issuedAtMs,
      }),
      privateKey,
    );
    attestationId = `att_${nanoid(16)}`;
    await db.insert(attestations).values({
      id: attestationId,
      issuerDid: sessionDid,
      subjectDid: client.appDid,
      type: 'app.authorized',
      contextId: client.id,
      contextType: 'app',
      payload,
      signature,
      issuedAt: new Date(issuedAtMs),
    });
  }

  // 6. Mint a single-use, PKCE-bound authorization code (store only its hash).
  const code = generateOpaqueToken();
  await db.insert(oauthAuthorizationCodes).values({
    id: `oac_${nanoid(16)}`,
    codeHash: hashToken(code),
    clientId: client.id,
    userDid: sessionDid,
    redirectUri,
    scope,
    codeChallenge,
    codeChallengeMethod: 'S256',
    resource: resource ?? MCP_RESOURCE,
    attestationId,
    expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
  });

  log.info({ clientId: client.id, userDid: sessionDid, scope }, 'oauth: issued authorization code');

  const redirect = new URL(redirectUri);
  redirect.searchParams.set('code', code);
  if (state) redirect.searchParams.set('state', state);
  return NextResponse.redirect(redirect);
}
