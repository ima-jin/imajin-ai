/**
 * MCP OAuth 2.1 configuration + pure helpers (RFC 8414 / 9728 / 9207 / 7636 / 8707).
 *
 * Single source of truth for the issuer, endpoint URLs, the protected-resource
 * identifier (== access-token `aud`), and the supported scopes that the
 * `.well-known` discovery docs, /oauth/authorize, /oauth/token, and /mcp all
 * read from. Keep this module free of DB / Next imports so discovery docs and
 * route handlers can import it without coupling.
 *
 * Part of #1166 (MCP connector for Claude Desktop). Route sketch — see the
 * handlers under app/.well-known, app/oauth, and app/mcp.
 *
 * ─── 2026-07-28 authorization diff (#1474) ─────────────────────────────────
 *
 * Diffed this module and the discovery docs against
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
 * and its changelog. Result, item by item:
 *
 *   - RFC 9728 (protected resource metadata) — "MCP servers MUST implement".
 *     Satisfied: app/.well-known/oauth-protected-resource + the `resource_metadata`
 *     pointer in the /mcp 401 challenge. No new REQUIRED members; `resource` is
 *     the only one RFC 9728 mandates and we publish it plus
 *     `authorization_servers`, `scopes_supported`, `bearer_methods_supported`.
 *   - RFC 8414 / OIDC discovery — "MUST provide at least one". Satisfied by
 *     app/.well-known/oauth-authorization-server; no OIDC doc is required as a
 *     result. No newly-required members in this revision.
 *   - RFC 8707 (resource indicators / audience binding) — unchanged. Satisfied:
 *     getMcpResource() is both the advertised `resource` and the token `aud`,
 *     and /mcp rejects any token whose `aud` differs.
 *   - RFC 7591 (DCR) — reclassified as DEPRECATED, "retained for backwards
 *     compatibility". We keep it because Claude Desktop still requires a
 *     `registration_endpoint`. No change; Client ID Metadata Documents
 *     (draft-ietf-oauth-client-id-metadata-document) is a SHOULD and is the
 *     forward path, tracked separately.
 *   - RFC 9207 (issuer identification) — NEW to the standards list in this
 *     revision, and the one real gap we found. Addressed below: see
 *     ISSUER_IDENTIFICATION_SUPPORTED / withIssuerIdentification().
 *
 * Two further items are SHOULDs deliberately left alone, recorded so the next
 * diff does not re-litigate them:
 *   - `scope` in the WWW-Authenticate challenge. Our `scopes_supported` is the
 *     whole MCP ceiling, so echoing it into the challenge would tell clients to
 *     request everything — the opposite of the least-privilege intent. Wiring a
 *     per-request required-scope challenge belongs with the step-up flow.
 *   - `application_type` at DCR is a requirement on CLIENTS, not on us.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CONNECTOR_DIDS, CONNECTOR_CHANNELS, scopesForSurface } from '@imajin/auth/scope-vocabulary';

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
 * and in `auth.channel_links.appDid` for media/connections grant rows. Sourced
 * from the scope vocabulary (#1253), which is the only place connector DIDs are
 * declared.
 */
export const MCP_CONNECTOR_DID = CONNECTOR_DIDS.mcp;

/**
 * Channel label for MCP connector rows in `auth.channel_links` (#1222).
 * Matches the `channel:` field in the user's MCP scope-manifest.
 */
export const MCP_CHANNEL = CONNECTOR_CHANNELS.mcp;

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
 * RFC 9207 — OAuth 2.0 Authorization Server Issuer Identification (#1474).
 *
 * MCP `2026-07-28` added RFC 9207 to the authorization standards list: an AS
 * SHOULD return `iss` on every authorization response, and an MCP client MUST
 * validate a present `iss` against the issuer it recorded before redeeming the
 * code. Without it, a client talking to several authorization servers cannot
 * tell WHICH one produced a given `code`/`state`, which is the whole mechanic
 * of an OAuth mix-up attack: a malicious (or compromised) AS induces the client
 * to redeem its code at an honest AS, or vice versa.
 *
 * We are the AS here (/oauth/authorize), so this is ours to emit. It also has
 * to be advertised: RFC 9207 §3 defines
 * `authorization_response_iss_parameter_supported` in the RFC 8414 metadata,
 * and a client cannot start REQUIRING `iss` from us until we say we send it.
 *
 * Adding `iss` is backwards compatible — a client that does not understand the
 * parameter ignores an extra query member.
 */
export const ISSUER_IDENTIFICATION_SUPPORTED = true;

/**
 * Attach the RFC 9207 `iss` parameter to an authorization response URL.
 *
 * Applies to BOTH success (`?code=…`) and error (`?error=…`) redirects: RFC
 * 9207 §2 covers "authorization responses", and an attacker who could strip
 * `iss` from error responses only would still get a channel the client cannot
 * attribute. Mutates and returns the URL so callers can keep chaining.
 */
export function withIssuerIdentification(url: URL): URL {
  url.searchParams.set('iss', getMcpIssuer());
  return url;
}

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

/**
 * True iff an incoming authorize/token `redirect_uri` matches the client's
 * registered `callbackUrl`.
 *
 * DCR stores only the FIRST registered redirect_uri as the canonical
 * `callbackUrl`, but a client may register several loopback callbacks and then
 * authorize with a different one (e.g. MCP Inspector stores `/oauth/callback`
 * but authorizes with `/oauth/callback/debug`). Accept the incoming URI when:
 *   1. it EXACTLY equals the stored callbackUrl (the normal case), OR
 *   2. BOTH are loopback redirects on the SAME origin (scheme+host+port) — the
 *      path may differ. Safe because the code is PKCE-bound and the origin is a
 *      loopback interface the legitimate client controls.
 *
 * This is a narrow bridge until a proper multi-redirect_uri manager lands
 * (stores + matches the full registered set). See the tracking issue.
 */
export function redirectUriMatches(incoming: string | null | undefined, registered: string): incoming is string {
  if (!incoming) return false;
  if (incoming === registered) return true;
  if (!isLoopbackRedirectUri(incoming) || !isLoopbackRedirectUri(registered)) return false;
  try {
    return new URL(incoming).origin === new URL(registered).origin;
  } catch {
    return false;
  }
}

/** True iff EVERY requested redirect_uri is allowed. */
export function areRedirectUrisAllowed(uris: readonly string[]): boolean {
  if (uris.length === 0) return false;
  const allow = new Set(DCR_ALLOWED_REDIRECT_URIS);
  return uris.every((u) => allow.has(u) || isLoopbackRedirectUri(u));
}

/**
 * Scopes the MCP surface supports — the OAuth token capability ceiling.
 *
 * DERIVED (#1253): every vocabulary entry tagged `surfaces: ['mcp']`, in
 * vocabulary order. Previously a hand-maintained tuple that had to be kept in
 * sync with `SCOPES`, the connector descriptors, and the connector-card list;
 * #1393 missed one of those copies and shipped an ungrantable scope to prod.
 *
 * Note this is a *ceiling*, not ownership: `github:*` is owned by the GitHub
 * connector but is legitimately carried by MCP tokens, so those entries are
 * `connector: 'github'` with `surfaces: ['mcp']`.
 *
 * A given client only receives a scope if its registry.apps.requested_scopes
 * includes it — no existing client gains new capability implicitly.
 */
export const MCP_SCOPES: readonly string[] = scopesForSurface('mcp');
export const MCP_SCOPE_SET = new Set<string>(MCP_SCOPES);

export const ACCESS_TOKEN_TTL_SECONDS = 600; // matches createAppToken (10 min)
export const AUTHORIZATION_CODE_TTL_MS = 60_000; // 60s, single-use
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Space-delimited scope string → filtered list of scopes we actually support. */
export function filterGrantedScopes(requested: string | null | undefined): string[] {
  if (!requested) return [];
  return requested.split(/\s+/).filter((s) => s.length > 0 && MCP_SCOPE_SET.has(s));
}

/**
 * Resolve the scopes to grant for an authorization request.
 *
 * RFC 6749 §3.3 makes `scope` OPTIONAL on the authorization request: when the
 * client omits it the AS "MUST ... process the request using a pre-defined
 * default value" — it must NOT fail. For a dynamically registered client the
 * natural default is the scope set that client registered at DCR time.
 *
 * Previously both /oauth/authorize gates ran the raw param through
 * filterGrantedScopes() unconditionally, so an ABSENT `scope` produced an empty
 * list and dead-ended the ceremony with `error=invalid_scope`. Any MCP client
 * that omits `scope` and relies on the AS default could never connect.
 *
 * Widening remains impossible:
 *   - an EXPLICIT scope is intersected with the client's registered set, so a
 *     client can never ask for more than it registered;
 *   - the fallback re-runs the registered set through filterGrantedScopes(), so
 *     the MCP ceiling still applies even if a stale registry row holds a scope
 *     we no longer support.
 *
 * Returns [] only when the client genuinely has no usable scopes — callers keep
 * emitting `invalid_scope` for that case, which is the correct response.
 */
export function resolveGrantedScopes(
  scopeParam: string | null | undefined,
  registeredScopes: readonly string[] | null | undefined,
): string[] {
  const registered = registeredScopes ?? [];
  if (!scopeParam || scopeParam.trim().length === 0) {
    return filterGrantedScopes(registered.join(' '));
  }
  const allowed = new Set(registered);
  return filterGrantedScopes(scopeParam).filter((s) => allowed.has(s));
}

/**
 * Re-resolve the scope string to carry on a REFRESH cycle (#1630).
 *
 * A refresh used to mint its successor tokens from the scope string frozen on
 * the ORIGINAL authorization code, so the whole rotation lineage was stuck with
 * whatever the client held at first-connect. A scope added to the vocabulary and
 * toggled on afterwards (e.g. `messages:read`, #1393) never reached the JWT, so
 * the per-tool gate in server.ts (`ctx.scopes.has(...)`, which reads the JWT
 * `scope` claim) answered `insufficient_scope` forever — even though the live
 * channel_links gate would have allowed the call. The only escape was a full
 * disconnect + re-authorize in the client.
 *
 * So a refresh now recomputes registered ∩ MCP-ceiling from CURRENT state:
 *   - `registry.apps.requested_scopes` — what the client is registered for;
 *   - `MCP_SCOPE_SET` (via filterGrantedScopes) — the surface ceiling, so a
 *     stale registry row holding a retired scope can't leak through.
 *
 * Widening past the client's registration stays impossible: this is an
 * intersection, never a union, and it never consults the requested scope from
 * the caller. Two consequences are deliberate:
 *   - a scope REMOVED from the registration disappears on the next refresh;
 *   - a scope ADDED to the registration appears on the next refresh, without a
 *     re-authorization ceremony (the #1630 tradeoff — see the issue).
 *
 * Returns [] when the client has nothing grantable left; callers must treat that
 * as `invalid_scope` rather than minting a scopeless token.
 */
export function resolveRefreshScopes(registeredScopes: readonly string[] | null | undefined): string[] {
  const registered = registeredScopes ?? [];
  return [...new Set(filterGrantedScopes(registered.join(' ')))];
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
