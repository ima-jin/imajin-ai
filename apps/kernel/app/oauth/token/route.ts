import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { eq, and, isNull } from 'drizzle-orm';
import { db, registryApps, attestations, oauthAuthorizationCodes, oauthRefreshTokens } from '@/src/db';
import { createAppToken } from '@/src/lib/auth/jwt';
import { createLogger } from '@imajin/logger';
import { rateLimit, getClientIP } from '@imajin/config';
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

function tooManyRequests(retryAfter: number) {
  return NextResponse.json(
    { error: 'slow_down', error_description: 'rate limit exceeded' },
    { status: 429, headers: { ...NO_STORE, 'Retry-After': String(retryAfter) } },
  );
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
  // Rate-limit this public, unauthenticated endpoint: per-IP, then per-client_id.
  const ip = getClientIP(request);
  const ipLimit = rateLimit(`oauth-token:ip:${ip}`, 60, 60_000);
  if (ipLimit.limited) return tooManyRequests(ipLimit.retryAfter);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return tokenError('invalid_request', 400, 'expected application/x-www-form-urlencoded');
  }

  const clientId = form.get('client_id')?.toString();
  if (clientId) {
    const clientLimit = rateLimit(`oauth-token:client:${clientId}`, 120, 60_000);
    if (clientLimit.limited) return tooManyRequests(clientLimit.retryAfter);
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

  // Atomic single-use consume: mark used ONLY if currently unused, returning the
  // row. A concurrent replay loses the race → no row → invalid_grant. All checks
  // run against the consumed row; a failed check still burns the code (correct for
  // single-use — there is no window between read and mark-used).
  const [record] = await db
    .update(oauthAuthorizationCodes)
    .set({ usedAt: new Date() })
    .where(and(
      eq(oauthAuthorizationCodes.codeHash, hashToken(code)),
      isNull(oauthAuthorizationCodes.usedAt),
    ))
    .returning();

  if (!record) {
    return tokenError('invalid_grant', 400, 'code invalid or already used');
  }
  if (record.expiresAt.getTime() < Date.now()) {
    return tokenError('invalid_grant', 400, 'code expired');
  }
  if (record.clientId !== clientId || record.redirectUri !== redirectUri) {
    return tokenError('invalid_grant', 400, 'client_id / redirect_uri mismatch');
  }

  // PKCE S256: base64url(sha256(code_verifier)) must equal the stored challenge.
  if (!safeEqual(pkceChallengeFromVerifier(codeVerifier), record.codeChallenge)) {
    return tokenError('invalid_grant', 400, 'PKCE verification failed');
  }

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

  if (!record || record.clientId !== clientId) {
    return tokenError('invalid_grant', 400, 'refresh token invalid');
  }

  // Reuse detection (OAuth 2.1 §6.1): an ALREADY-revoked token presented again is
  // a rotated-out token being replayed — the stolen-token signal. Kill the whole
  // grant. Every token in the rotation lineage shares this attestationId, so
  // revoking by attestationId revokes the entire chain in one statement (more
  // robust than walking rotatedTo, which could miss a token if a link broke), and
  // revoking the attestation blocks any further mint via this grant.
  if (record.revokedAt) {
    const revokedAt = new Date();
    await db
      .update(oauthRefreshTokens)
      .set({ revokedAt })
      .where(and(
        eq(oauthRefreshTokens.attestationId, record.attestationId),
        isNull(oauthRefreshTokens.revokedAt),
      ));
    await db
      .update(attestations)
      .set({ revokedAt })
      .where(and(eq(attestations.id, record.attestationId), isNull(attestations.revokedAt)));
    log.warn(
      { clientId: record.clientId, userDid: record.userDid, attestationId: record.attestationId },
      'oauth: refresh token reuse detected — grant revoked',
    );
    return tokenError('invalid_grant', 400, 'refresh token reuse detected; authorization revoked');
  }

  if (record.expiresAt.getTime() < Date.now()) {
    return tokenError('invalid_grant', 400, 'refresh token expired');
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

  // Atomic rotation: consume the presented token only if still active. Losing the
  // race (concurrent rotation) yields 0 rows → deny, so a token can't rotate twice.
  const consumed = await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: new Date(), lastUsedAt: new Date() })
    .where(and(eq(oauthRefreshTokens.id, record.id), isNull(oauthRefreshTokens.revokedAt)))
    .returning({ id: oauthRefreshTokens.id });
  if (consumed.length === 0) {
    return tokenError('invalid_grant', 400, 'refresh token already used');
  }

  // Issue successor, then link the rotation chain (rotatedTo powers reuse audit).
  const successor = await issueRefreshToken({
    clientId: record.clientId,
    userDid: record.userDid,
    scope: record.scope,
    attestationId: record.attestationId,
  });
  await db
    .update(oauthRefreshTokens)
    .set({ rotatedTo: successor.id })
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
