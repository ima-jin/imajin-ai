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

/** True iff EVERY requested redirect_uri is on the exact-match allowlist. */
export function areRedirectUrisAllowed(uris: readonly string[]): boolean {
  if (uris.length === 0) return false;
  const allow = new Set(DCR_ALLOWED_REDIRECT_URIS);
  return uris.every((u) => allow.has(u));
}

/**
 * Media scopes the MCP surface supports (read + create/write). NOTE: each string
 * must also exist in the shared SCOPES vocabulary in packages/auth/src/scopes.ts
 * so the consent listing (/auth/apps) and validateScopes() recognize it.
 *
 * `media:write` is server-supported here, but a given client only receives it if
 * its registry.apps.requested_scopes includes it — the Claude seed (0052) stays
 * read-only, so no existing client gains write capability implicitly.
 */
export const MCP_SCOPES = ['media:read', 'media:write'] as const;
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
