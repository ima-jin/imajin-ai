-- 0051_oauth_mcp_tables.sql
-- OAuth 2.1 server tables for the MCP connector (Issue #1166).
-- Mirrors apps/kernel/src/db/schemas/oauth.ts. Idempotent DDL.
--
-- Auth codes + refresh tokens are stored as SHA-256 hashes only (never raw).
-- Both back the Claude Desktop public-client + PKCE flow; the grant itself is an
-- app.authorized attestation (see attestation_id), so /auth/apps + /api/auth/revoke
-- remain the revoke story.

-- ---------------------------------------------------------------------------
-- Authorization codes — short-lived, single-use, PKCE-bound
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth.oauth_authorization_codes (
  id                    TEXT PRIMARY KEY,
  code_hash             TEXT NOT NULL UNIQUE,            -- sha256(code)
  client_id             TEXT NOT NULL,                   -- registry.apps.id
  user_did              TEXT NOT NULL,                   -- resource owner (session DID)
  redirect_uri          TEXT NOT NULL,
  scope                 TEXT NOT NULL,                   -- space-delimited granted scopes
  code_challenge        TEXT NOT NULL,                   -- PKCE S256 challenge
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  resource              TEXT,                            -- RFC 8707 audience (optional)
  attestation_id        TEXT NOT NULL,                   -- app.authorized linkage
  expires_at            TIMESTAMPTZ NOT NULL,            -- ~60s TTL
  used_at               TIMESTAMPTZ,                     -- single-use marker
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires
  ON auth.oauth_authorization_codes (expires_at);

-- ---------------------------------------------------------------------------
-- Refresh tokens — opaque, rotating, hashed at rest
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth.oauth_refresh_tokens (
  id             TEXT PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE,                   -- sha256(token)
  client_id      TEXT NOT NULL,
  user_did       TEXT NOT NULL,
  scope          TEXT NOT NULL,
  attestation_id TEXT NOT NULL,
  rotated_to     TEXT,                                   -- successor id after rotation
  expires_at     TIMESTAMPTZ NOT NULL,                   -- ~90d TTL
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user
  ON auth.oauth_refresh_tokens (user_did);
