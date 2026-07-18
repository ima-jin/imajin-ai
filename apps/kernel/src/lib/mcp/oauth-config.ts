/**
 * MCP OAuth 2.1 configuration + pure helpers (RFC 8414 / 9728 / 7636 / 8707).
 *
 * Single source of truth for the issuer, endpoint URLs, the protected-resource
 * identifier (== access-token `aud`), and the supported scopes that the
 * `.well-known` discovery docs, /oauth/authorize, /oauth/token, and /mcp all
 * read from. Keep this module free of DB / Next imports so discovery docs and
 * route handlers can import it without coupling.
 *
 * Part of #1166 (MCP connector for Claude Desktop). Route sketch — see the
 * handlers under app/.well-known, app/oauth, and app/mcp.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Public origin of the MCP server (Caddy → kernel). e.g. https://mcp.imajin.ai */
export function getMcpIssuer(): string {
  return process.env.MCP_PUBLIC_URL ?? 'https://mcp.imajin.ai';
}

/** @deprecated Use getMcpIssuer() to avoid stale env capture at module-eval time. */
export const MCP_ISSUER = getMcpIssuer();

/**
 * Connector app DID for the Claude/MCP connector (#1222).
 *
 * This is the DID that appears in the user's MCP scope-manifest as `connector:`
 * and in `auth.channel_links.appDid` for media/connections grant rows. Mirrors
 * GITHUB_CONNECTOR_DID in src/lib/github/connector.ts.
 */
export const MCP_CONNECTOR_DID = 'did:imajin:mcp-connector';

/**
 * Channel label for MCP connector rows in `auth.channel_links` (#1222).
 * Matches the `channel:` field in the user's MCP scope-manifest.
 */
export const MCP_CHANNEL = 'mcp';

/** RFC 8707 resource indicator == access-token `aud`. Also the JSON-RPC path. */
export function getMcpResource(): string {
  return `${getMcpIssuer()}/mcp`;
}

/** @deprecated Use getMcpResource() to avoid stale env capture at module-eval time. */
export const MCP_RESOURCE = getMcpResource();

export function getAuthorizationEndpoint(): string {
  return `${getMcpIssuer()}/oauth/authorize`;
}

export function getTokenEndpoint(): string {
  return `${getMcpIssuer()}/oauth/token`;
}

export function getRegistrationEndpoint(): string {
  return `${getMcpIssuer()}/oauth/register`;
}

export function getProtectedResourceMetadataUrl(): string {
  return `${getMcpIssuer()}/.well-known/oauth-protected-resource`;
}

/** @deprecated Use getAuthorizationEndpoint() to avoid stale env capture. */
export const OAUTH_AUTHORIZATION_ENDPOINT = getAuthorizationEndpoint();
/** @deprecated Use getTokenEndpoint() to avoid stale env capture. */
export const OAUTH_TOKEN_ENDPOINT = getTokenEndpoint();
/** @deprecated Use getRegistrationEndpoint() to avoid stale env capture. */
export const OAUTH_REGISTRATION_ENDPOINT = getRegistrationEndpoint();
/** @deprecated Use getProtectedResourceMetadataUrl() to avoid stale env capture. */
export const PROTECTED_RESOURCE_METADATA_URL = getProtectedResourceMetadataUrl();

/**
 * Redirect-URI allowlist for Dynamic Client Registration (RFC 7591, #1185).
 *
 * Claude Desktop's connector flow REQUIRES DCR (it rejects an AS with no
 * `registration_endpoint` → `oauth_error=registration_endpoint_missing`), so we
 * cannot use the pre-registered-client-only model. A registered client is inert
 * — it grants nothing until a real DID consents — but the one risk that matters
 * is a phished consent via an attacker-controlled `redirect_uri`. We kill that by
 * accepting registration ONLY for exact, known Anthropic callback URLs.
 *
 * Exact-match only. No prefix/substring/wildcard matching, ever.
 */
export const DCR_ALLOWED_REDIRECT_URIS: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

/**
 * True iff the URI is an RFC 8252 §7.3 loopback redirect.
 *
 * Loopback redirects are safe to allow on any port AND any path because
 * OAuth 2.1 mandates PKCE S256 — the authorization code is bound to the
 * code challenge and cannot be exchanged by an attacker even if they race
 * the legitimate client on the same loopback interface.
 *
 * RFC 8252 pins only the HOST to loopback (127.0.0.1 / ::1 / localhost); it
 * places no constraint on the port or path. We previously hard-required
 * pathname === '/oauth/callback', which rejected clients that register a
 * second loopback callback — e.g. MCP Inspector registers BOTH
 * `/oauth/callback` and `/oauth/callback/debug`, and areRedirectUrisAllowed()
 * requires EVERY entry to pass, so the whole DCR was rejected. Security comes
 * from PKCE + the loopback host, not from the path, so we accept any path.
 */
export function isLoopbackRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  const host = url.hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** True iff EVERY requested redirect_uri is allowed. */
export function areRedirectUrisAllowed(uris: readonly string[]): boolean {
  if (uris.length === 0) return false;
  const allow = new Set(DCR_ALLOWED_REDIRECT_URIS);
  return uris.every((u) => allow.has(u) || isLoopbackRedirectUri(u));
}

/**
 * Scopes the MCP surface supports. NOTE: each string must also exist in the
 * shared SCOPES vocabulary in packages/auth/src/scopes.ts so the consent
 * listing (/auth/apps) and validateScopes() recognize it.
 *
 * Scope semantics:
 *   media:read        — list/get/read caller's media
 *   media:write       — create/update caller's own media
 *   media:share       — add/remove allowedDids on caller's assets (crosses
 *                       sovereignty boundary; distinct from media:write)
 *   connections:read  — enumerate caller's trust-graph connections (used by
 *                       connections_list to resolve a name → DID for sharing)
 *
 * A given client only receives a scope if its registry.apps.requested_scopes
 * includes it — no existing client gains new capability implicitly.
 */
export const MCP_SCOPES = [
  'media:read',
  'media:write',
  'media:share',
  'connections:read',
  'github:read',
  'github:write',
  'github:org',
  'github:actions',
] as const;
export const MCP_SCOPE_SET = new Set<string>(MCP_SCOPES);

export const ACCESS_TOKEN_TTL_SECONDS = 600; // matches createAppToken (10 min)
export const AUTHORIZATION_CODE_TTL_MS = 60_000; // 60s, single-use
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Space-delimited scope string → filtered list of scopes we actually support. */
export function filterGrantedScopes(requested: string | null | undefined): string[] {
  if (!requested) return [];
  return requested.split(/\s+/).filter((s) => s.length > 0 && MCP_SCOPE_SET.has(s));
}

/** PKCE S256: base64url(SHA-256(verifier)). */
export function pkceChallengeFromVerifier(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Opaque high-entropy secret (authorization code / refresh token). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Hash opaque secrets at rest (codes, refresh tokens are never stored raw). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time string compare (PKCE challenge match). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
