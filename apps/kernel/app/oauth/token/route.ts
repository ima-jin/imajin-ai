import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { db, registryApps, attestations, oauthAuthorizationCodes, oauthRefreshTokens } from '@/src/db';
import { createAppToken } from '@/src/lib/auth/jwt';
import { createLogger } from '@imajin/logger';
import {
  MCP_RESOURCE,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_MS,
  pkceChallengeFromVerifier,
  generateOpaqueToken,
  hashToken,
  safeEqual,
} from '@/src/lib/mcp/oauth-config';

const log = createLogger('kernel');
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function tokenError(error: string, status = 400, description?: string) {
  return NextResponse.json(
    { error, ...(description ? { error_description: description } : {}) },
    { status, headers: NO_STORE },
  );
}

function tokenResponse(body: Record<string, unknown>) {
  return NextResponse.json(body, { headers: NO_STORE });
}

/** OAuth access token = short-lived app+jwt (sub=user DID, azp=app, aud=MCP resource). */
function mintAccessToken(opts: { userDid: string; appDid: string; scope: string; attestationId: string }) {
  return createAppToken({
    sub: opts.userDid,
    azp: opts.appDid,
    scope: opts.scope,
    aud: MCP_RESOURCE,
    attestationId: opts.attestationId,
  });
}

async function issueRefreshToken(opts: { clientId: string; userDid: string; scope: string; attestationId: string }) {
  const token = generateOpaqueToken();
  const id = `ort_${nanoid(16)}`;
  await db.insert(oauthRefreshTokens).values({
    id,
    tokenHash: hashToken(token),
    clientId: opts.clientId,
    userDid: opts.userDid,
    scope: opts.scope,
    attestationId: opts.attestationId,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  return { token, id };
}

/**
 * POST /oauth/token — OAuth 2.1 token endpoint (public client; form-encoded).
 * Supports grant_type = authorization_code (PKCE) and refresh_token (rotating).
 * No client authentication / PoP — PKCE binds the code to the requester.
 */
export async function POST(request: NextRequest) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return tokenError('invalid_request', 400, 'expected application/x-www-form-urlencoded');
  }

  const grantType = form.get('grant_type')?.toString();
  if (grantType === 'authorization_code') return handleAuthorizationCode(form);
  if (grantType === 'refresh_token') return handleRefreshToken(form);
  return tokenError('unsupported_grant_type');
}

async function handleAuthorizationCode(form: FormData) {
  const code = form.get('code')?.toString();
  const clientId = form.get('client_id')?.toString();
  const redirectUri = form.get('redirect_uri')?.toString();
  const codeVerifier = form.get('code_verifier')?.toString();

  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return tokenError('invalid_request', 400, 'code, client_id, redirect_uri, code_verifier required');
  }

  const [record] = await db
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, hashToken(code)))
    .limit(1);

  // Single-use + expiry + binding checks.
  // TODO: wrap consume-and-mint in a transaction (or DELETE…RETURNING) so a
  //       concurrent replay can't ride the window between SELECT and UPDATE.
  if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
    return tokenError('invalid_grant', 400, 'code invalid or expired');
  }
  if (record.clientId !== clientId || record.redirectUri !== redirectUri) {
    return tokenError('invalid_grant', 400, 'client_id / redirect_uri mismatch');
  }

  // PKCE S256: base64url(sha256(code_verifier)) must equal the stored challenge.
  if (!safeEqual(pkceChallengeFromVerifier(codeVerifier), record.codeChallenge)) {
    return tokenError('invalid_grant', 400, 'PKCE verification failed');
  }

  await db.update(oauthAuthorizationCodes).set({ usedAt: new Date() }).where(eq(oauthAuthorizationCodes.id, record.id));

  const [client] = await db
    .select({ appDid: registryApps.appDid, status: registryApps.status })
    .from(registryApps)
    .where(eq(registryApps.id, record.clientId))
    .limit(1);
  if (!client || client.status !== 'active') {
    return tokenError('invalid_client', 401, 'client inactive');
  }

  const accessToken = await mintAccessToken({
    userDid: record.userDid,
    appDid: client.appDid,
    scope: record.scope,
    attestationId: record.attestationId,
  });
  const refresh = await issueRefreshToken({
    clientId: record.clientId,
    userDid: record.userDid,
    scope: record.scope,
    attestationId: record.attestationId,
  });

  log.info({ clientId: record.clientId, userDid: record.userDid }, 'oauth: authorization_code → tokens');

  return tokenResponse({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh.token,
    scope: record.scope,
  });
}

async function handleRefreshToken(form: FormData) {
  const refreshToken = form.get('refresh_token')?.toString();
  const clientId = form.get('client_id')?.toString();
  if (!refreshToken || !clientId) {
    return tokenError('invalid_request', 400, 'refresh_token, client_id required');
  }

  const [record] = await db
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, hashToken(refreshToken)))
    .limit(1);

  if (!record || record.revokedAt || record.expiresAt.getTime() < Date.now() || record.clientId !== clientId) {
    // TODO: if a REVOKED token is presented, treat as reuse → revoke the whole
    //       rotation chain (record.rotatedTo …) and the grant.
    return tokenError('invalid_grant', 400, 'refresh token invalid');
  }

  // Instant-revoke story: deny if the backing app.authorized attestation was revoked.
  const [att] = await db
    .select({ revokedAt: attestations.revokedAt })
    .from(attestations)
    .where(eq(attestations.id, record.attestationId))
    .limit(1);
  if (!att || att.revokedAt) {
    return tokenError('invalid_grant', 400, 'authorization revoked');
  }

  const [client] = await db
    .select({ appDid: registryApps.appDid, status: registryApps.status })
    .from(registryApps)
    .where(eq(registryApps.id, record.clientId))
    .limit(1);
  if (!client || client.status !== 'active') {
    return tokenError('invalid_client', 401, 'client inactive');
  }

  // Rotate: issue successor, then revoke the presented token and chain to it.
  const successor = await issueRefreshToken({
    clientId: record.clientId,
    userDid: record.userDid,
    scope: record.scope,
    attestationId: record.attestationId,
  });
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: new Date(), rotatedTo: successor.id, lastUsedAt: new Date() })
    .where(eq(oauthRefreshTokens.id, record.id));

  const accessToken = await mintAccessToken({
    userDid: record.userDid,
    appDid: client.appDid,
    scope: record.scope,
    attestationId: record.attestationId,
  });

  log.info({ clientId: record.clientId, userDid: record.userDid }, 'oauth: refresh_token → rotated tokens');

  return tokenResponse({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: successor.token,
    scope: record.scope,
  });
}
