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
export const MCP_ISSUER = process.env.MCP_PUBLIC_URL ?? 'https://mcp.imajin.ai';

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
export const MCP_RESOURCE = `${MCP_ISSUER}/mcp`;

export const OAUTH_AUTHORIZATION_ENDPOINT = `${MCP_ISSUER}/oauth/authorize`;
export const OAUTH_TOKEN_ENDPOINT = `${MCP_ISSUER}/oauth/token`;
export const OAUTH_REGISTRATION_ENDPOINT = `${MCP_ISSUER}/oauth/register`;
export const PROTECTED_RESOURCE_METADATA_URL = `${MCP_ISSUER}/.well-known/oauth-protected-resource`;

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
 * Local-dev redirect URIs for the MCP Inspector
 * (`npx @modelcontextprotocol/inspector`), used to invoke connector tools like
 * `github_connect` WITHOUT routing a raw credential through a hosted chat
 * client. These are OFF by default — prod stays locked to the exact Anthropic
 * callbacks above. An operator opts in for a single Inspector session by setting
 * `MCP_ALLOW_LOCAL_DCR=1`, then unsets it. Still exact-match (no wildcard): an
 * attacker would need to already control a listener on the victim's own
 * loopback port, and the flag must be explicitly on.
 */
export const DCR_LOCAL_DEV_REDIRECT_URIS: readonly string[] = [
  'http://localhost:6274/oauth/callback',
  'http://127.0.0.1:6274/oauth/callback',
];

/** True iff local-dev DCR (MCP Inspector) is explicitly enabled via env. */
export function isLocalDcrEnabled(): boolean {
  return process.env.MCP_ALLOW_LOCAL_DCR === '1';
}

/** The active exact-match allowlist: Anthropic always, local-dev only when opted in. */
export function activeRedirectAllowlist(): readonly string[] {
  return isLocalDcrEnabled()
    ? [...DCR_ALLOWED_REDIRECT_URIS, ...DCR_LOCAL_DEV_REDIRECT_URIS]
    : DCR_ALLOWED_REDIRECT_URIS;
}

/** True iff EVERY requested redirect_uri is on the active exact-match allowlist. */
export function areRedirectUrisAllowed(uris: readonly string[]): boolean {
  if (uris.length === 0) return false;
  const allow = new Set(activeRedirectAllowlist());
  return uris.every((u) => allow.has(u));
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
const MCP_SCOPE_SET = new Set<string>(MCP_SCOPES);

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
