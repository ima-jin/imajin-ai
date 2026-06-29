import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { db, registryApps } from '@/src/db';
import { createLogger } from '@imajin/logger';
import { rateLimit, getClientIP } from '@imajin/config';
import {
  MCP_SCOPES,
  areRedirectUrisAllowed,
  filterGrantedScopes,
} from '@/src/lib/mcp/oauth-config';

const log = createLogger('kernel');
export const dynamic = 'force-dynamic';

// Registration is called server-to-server by the OAuth client (Claude Desktop),
// not as a browser fetch from an arbitrary origin — so NO permissive CORS. We
// match the /oauth/token route: no-store, no wildcard Access-Control-Allow-Origin.
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

/** RFC 7591 error body. */
function regError(error: string, description: string, status = 400) {
  return NextResponse.json({ error, error_description: description }, { status, headers: NO_STORE });
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === 'string')) return null;
  return value as string[];
}

/**
 * POST /oauth/register — RFC 7591 OAuth 2.0 Dynamic Client Registration (#1185).
 *
 * Claude Desktop's connector flow requires this endpoint; the pre-registered
 * client model (#1166) was rejected with `registration_endpoint_missing`.
 *
 * SECURITY MODEL — why an unauthenticated public registration is safe here:
 * - A registered client is INERT. It only records "this client MAY ask for
 *   scopes X with redirect Y." It grants ZERO access to any asset.
 * - The real gate is unchanged: /oauth/authorize requires a logged-in DID
 *   SESSION and an explicit consent commit before any token is minted.
 * - The one risk that matters — a phished consent via an attacker-controlled
 *   redirect_uri — is killed here by an EXACT-match redirect allowlist
 *   (Anthropic callbacks only). PKCE further binds the code to the client.
 * - Scopes are capped to the MCP media scopes; a registered client can never
 *   request anything outside `media:read` / `media:write`.
 * - Rate-limited per-IP to keep registration spam from filling registry.apps.
 *
 * Public client only: no client_secret is issued (token_endpoint_auth_method
 * is forced to "none"); security comes from PKCE, not a secret.
 */
export async function POST(request: NextRequest) {
  const ip = getClientIP(request);
  const limit = rateLimit(`oauth-register:ip:${ip}`, 10, 60_000);
  if (limit.limited) {
    return new NextResponse('Too Many Requests', {
      status: 429,
      headers: { ...NO_STORE, 'Retry-After': String(limit.retryAfter) },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return regError('invalid_client_metadata', 'invalid JSON body');
  }

  // 1. redirect_uris — required, and every entry must be on the exact allowlist.
  const redirectUris = asStringArray(body.redirect_uris);
  if (!redirectUris || redirectUris.length === 0) {
    return regError('invalid_redirect_uri', 'redirect_uris is required and must be a non-empty array of strings');
  }
  if (!areRedirectUrisAllowed(redirectUris)) {
    return regError('invalid_redirect_uri', 'one or more redirect_uris are not on the allowlist');
  }

  // 2. Auth method — public client only. Reject any attempt to register a
  //    confidential client; we never issue a client_secret.
  const authMethod = typeof body.token_endpoint_auth_method === 'string'
    ? body.token_endpoint_auth_method
    : 'none';
  if (authMethod !== 'none') {
    return regError('invalid_client_metadata', 'only public clients (token_endpoint_auth_method=none) are supported');
  }

  // 3. Scopes — cap to MCP media scopes. Default to read+write if unspecified.
  //    `scope` is a space-delimited string per RFC 7591.
  const requestedScope = typeof body.scope === 'string' ? body.scope : MCP_SCOPES.join(' ');
  const grantedScopes = filterGrantedScopes(requestedScope);
  const scopes = grantedScopes.length > 0 ? grantedScopes : [...MCP_SCOPES];

  // 4. Cosmetic metadata (optional).
  const clientName = typeof body.client_name === 'string' && body.client_name.trim().length > 0
    ? body.client_name.trim().slice(0, 200)
    : 'MCP Client (dynamic)';
  const logoUrl = typeof body.logo_uri === 'string' ? body.logo_uri.slice(0, 500) : null;
  const homepageUrl = typeof body.client_uri === 'string' ? body.client_uri.slice(0, 500) : null;

  // 5. Persist. The dedicated `/oauth/authorize` flow keys off a single
  //    callback_url, so we store the FIRST allowlisted redirect as the canonical
  //    callback (Claude registers exactly one). publicKey is a per-row unique
  //    placeholder — public clients never use it (no proof-of-possession), but
  //    the column is NOT NULL/UNIQUE.
  const clientId = `app_${nanoid(16)}`;
  const appDid = `did:imajin:mcp-${nanoid(36)}`;
  const placeholderKey = `dcr_${nanoid(60)}`; // unique, non-functional (public client)
  const callbackUrl = redirectUris[0];

  try {
    await db.insert(registryApps).values({
      id: clientId,
      ownerDid: 'did:imajin:platform', // first-party registrar (matches the 0052 seed)
      name: clientName,
      description: 'Dynamically registered MCP connector client (#1185, RFC 7591)',
      appDid,
      publicKey: placeholderKey,
      callbackUrl,
      homepageUrl,
      logoUrl,
      requestedScopes: scopes,
      status: 'active',
    });
  } catch (err) {
    log.error({ err, ip }, 'oauth/register: failed to persist dynamic client');
    return regError('server_error', 'failed to register client', 500);
  }

  log.info({ clientId, scopes, callbackUrl }, 'oauth/register: dynamic client registered (#1185)');

  // RFC 7591 §3.2.1 success response. No client_secret (public client).
  return NextResponse.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: scopes.join(' '),
      client_name: clientName,
    },
    { status: 201, headers: NO_STORE },
  );
}
