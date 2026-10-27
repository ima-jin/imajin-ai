/**
 * POST /auth/api/apps/token  (#1069 / #799 P3)
 * Principal-based grant resolution: #3040.
 *
 * Mint a short-lived, scoped app token. Replaces passing the raw attestationId
 * around as a long-lived bearer.
 *
 * The app proves possession of its keypair (signature over a challenge that
 * includes the attestationId or principalDid + a fresh nonce + timestamp), the kernel validates
 * the user's `app.authorized` attestation, then mints a ~10min EdDSA token that
 * downstream services verify locally against the kernel public key.
 *
 * Body: {
 *   appDid: string,
 *   attestationId?: string,  // exactly one of attestationId or principalDid
 *   principalDid?: string,   // resolve this principal's live grant at mint time
 *   scope?: string,          // optional single scope to narrow to (must be granted)
 *   aud?: string,            // optional target service
 *   nonce: string,           // client-generated, >= 16 chars
 *   timestamp: string,       // ISO; must be within 60s
 *   signature: string        // ed25519 hex over `${appDid}:${attestationId OR principalDid}:${nonce}:${timestamp}`
 * }
 * Returns: { token, expiresIn, scopes }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, attestations, registryApps } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { verifySignature } from '@/src/lib/auth/crypto';
import { createAppToken } from '@/src/lib/auth/jwt';
import { resolveActiveAppByAudience, appNotRegisteredResponse } from '@/src/lib/kernel/app-registry';
import { createLogger } from '@imajin/logger';
import { canConsentToApp, PRIVATE_APP_CONSENT_ERROR } from '@/src/lib/kernel/app-consent';
import { isLiveAppAuthorization } from '@/src/lib/auth/live-app-authorization';
import { recordAppAuthorizationUse } from '@/src/lib/auth/app-authorization-usage';
import { consumeAppAuthorizationCode } from '@/src/lib/auth/app-authorization-code';

export const dynamic = 'force-dynamic';

const log = createLogger('kernel');

const MAX_CLOCK_SKEW_MS = 60_000;

async function resolveAuthorization(appDid: string, selector: string, byPrincipal: boolean) {
  const rows = await db.select().from(attestations).where(and(
    eq(byPrincipal ? attestations.issuerDid : attestations.id, selector),
    eq(attestations.subjectDid, appDid),
    eq(attestations.type, 'app.authorized'),
  ));
  const now = Date.now();
  return byPrincipal ? rows.find(row => isLiveAppAuthorization(row, now)) : rows[0];
}

function validateMintRequest(body: Record<string, unknown>) {

  const { appDid, attestationId, principalDid, code, state, scope, aud, nonce, timestamp, signature } = (body ?? {}) as {
    appDid?: string;
    attestationId?: string;
    principalDid?: string;
    code?: string;
    state?: string;
    scope?: string;
    aud?: string;
    nonce?: string;
    timestamp?: string;
    signature?: string;
  };

  const selector = code ?? principalDid ?? attestationId;
  if (![appDid, selector, nonce, timestamp, signature].every(value => typeof value === 'string' && value.length > 0)) {
    return { error: 'appDid, selector, nonce, timestamp, signature are required', status: 400 };
  }
  if ([code, principalDid, attestationId].filter(value => value !== undefined).length !== 1) {
    return { error: 'Provide exactly one of code, attestationId or principalDid', status: 400 };
  }
  if (code !== undefined && (!/^[a-f0-9]{64}$/.test(code) || typeof state !== 'string' || state.length < 32 || state.length > 256)) {
    return { error: 'Invalid code or state', status: 400 };
  }
  if (nonce!.length < 16) {
    return { error: 'nonce too short', status: 400 };
  }

  // Freshness: reject stale/future timestamps (replay window bound)
  const ts = Date.parse(timestamp!);
  if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) {
    return { error: 'timestamp outside allowed window', status: 401 };
  }
  return {
    appDid: appDid!, selector: selector!, byPrincipal: principalDid !== undefined,
    code, state, scope, aud, nonce: nonce!, timestamp: timestamp!, signature: signature!,
  };
}

export async function POST(request: NextRequest) {
  const cors = { ...corsHeaders(request), 'Cache-Control': 'no-store' };

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }
  const mint = validateMintRequest(body);
  if ('error' in mint) {
    return NextResponse.json({ error: mint.error }, { status: mint.status, headers: cors });
  }
  const { appDid, selector, byPrincipal, code, state, scope, aud, nonce, timestamp, signature } = mint;

  // Proof of possession: app must sign with its own key. Resolve the public
  // key from registry.apps — the source of truth for developer app keys
  // (#1739) — rather than auth.identities. A promoted actor row for this
  // appDid can be stale or orphaned (e.g. a pre-#1735 `agent_<appId>`
  // sentinel, or a row `promoteActorOnGrant` skipped via onConflictDoNothing
  // because one already existed), which would poison PoP verification even
  // though the app's real key in registry.apps is fine.
  const [app] = await db
    .select({
      publicKey: registryApps.publicKey,
      name: registryApps.name,
      status: registryApps.status,
      visibility: registryApps.visibility,
      ownerDid: registryApps.ownerDid,
      signInAudience: registryApps.signInAudience,
      callbackUrl: registryApps.callbackUrl,
    })
    .from(registryApps)
    .where(eq(registryApps.appDid, appDid))
    .limit(1);
  if (!app) {
    return NextResponse.json({ error: 'Unknown app DID' }, { status: 404, headers: cors });
  }
  if (app.status !== 'active') {
    return NextResponse.json({ error: 'App is not active' }, { status: 403, headers: cors });
  }

  // #1990: when the caller names a specific resource audience, it must
  // itself be a registered, active app — an arbitrary string can no longer
  // stand in for a resource server. Omitting `aud` keeps the pre-existing
  // generic 'imajin:apps' default (createAppToken's fallback) untouched.
  if (aud && !(await resolveActiveAppByAudience(aud))) {
    return appNotRegisteredResponse(request);
  }

  const challenge = `${appDid}:${selector}:${nonce}:${timestamp}`;
  const pop = await verifySignature(challenge, signature, app.publicKey);
  if (!pop) {
    return NextResponse.json({ error: 'Invalid proof-of-possession signature' }, { status: 401, headers: cors });
  }

  // Validate the user's authorization attestation (same checks as /apps/validate)
  let grantSelector = selector;
  let codeSubject: string | undefined;
  if (code !== undefined) {
    const exchange = await consumeAppAuthorizationCode({ appDid, code, state: state!, callbackUrl: app.callbackUrl });
    if ('error' in exchange) {
      return NextResponse.json({ error: exchange.error }, { status: 400, headers: cors });
    }
    grantSelector = exchange.authorization.attestationId;
    codeSubject = exchange.authorization.subjectDid;
  }
  const att = await resolveAuthorization(appDid, grantSelector, byPrincipal);

  if (!att && byPrincipal) {
    return NextResponse.json(
      { code: 'no_live_grant', error: `Re-grant ${app.name} on /jin → Grants` },
      { status: 403, headers: cors }
    );
  }

  if (!att) {
    return NextResponse.json({ error: 'Authorization not found' }, { status: 404, headers: cors });
  }
  if (att.revokedAt) {
    return NextResponse.json({ error: 'Authorization has been revoked' }, { status: 403, headers: cors });
  }
  if (code !== undefined && (!isLiveAppAuthorization(att) || att.issuerDid !== codeSubject)) {
    return NextResponse.json({ error: 'code_invalid' }, { status: 400, headers: cors });
  }
  if (!await canConsentToApp(app, att.issuerDid)) {
    return NextResponse.json({ error: PRIVATE_APP_CONSENT_ERROR }, { status: 403, headers: cors });
  }

  const payload = att.payload as { scopes?: string[] } | null;
  const approvedScopes = payload?.scopes ?? [];

  // If the app narrows to a single scope, it must be one of the granted ones.
  if (scope && !approvedScopes.includes(scope)) {
    return NextResponse.json({ error: `Scope '${scope}' was not granted` }, { status: 403, headers: cors });
  }

  const grantedScopes = scope ? [scope] : approvedScopes;

  const token = await createAppToken({
    sub: att.issuerDid,
    azp: appDid,
    scope: grantedScopes.join(' '),
    aud,
    attestationId: att.id,
  });

  log.info({ appDid, userDid: att.issuerDid, scopes: grantedScopes }, 'minted app token');
  void recordAppAuthorizationUse(att.id);

  return NextResponse.json(
    {
      token, expiresIn: 600, scopes: grantedScopes,
      ...(code !== undefined ? { subjectDid: att.issuerDid, attestationId: att.id } : {}),
    },
    { headers: cors }
  );
}

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
