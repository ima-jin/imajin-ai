-- 0099_delegation_grants.sql
-- Scoped delegation grants for external agents — grant/revoke lifecycle on
-- actions (#1882), building on the #1881 Day-1 scope-resolution review
-- (2026-08-30, Ryan + Jin, following the nemotron /spec validation pass).
--
-- Settled design:
--   - Grants are auth-domain objects, NOT attestations. auth.* already holds
--     identities, credentials, tokens, and challenges; introspection is a hot
--     path checked per delegated action with short-TTL caching semantics
--     attestations were not designed for (see the issue's "attestations?"
--     open question — this migration answers it: auth-native table).
--   - Scope grammar is `domain:verb`, promoted from the MCP OAuth vocabulary
--     (packages/auth/src/scope-vocabulary.ts) plus kernel extensions — see
--     the closed registry in packages/auth/src/grant-scopes.ts.
--   - Resource targeting lives in `audience`, never in the scope string.
--   - Fail-closed: a revoked or expired grant fails the very next
--     introspection check. There is no background "expired" transition —
--     `status` only ever moves active -> revoked; expiry is a plain
--     timestamp compared at read time, never swept into a cached status.
--
-- Two tables:
--   delegation_grants             — one row per (delegatorDid, agentDid,
--                                    audience, expiry) grant.
--   delegation_grant_capabilities — one row per capability within a grant,
--                                    so a single scope can be revoked
--                                    without touching its siblings or the
--                                    parent grant (#1882 item 4).
--
-- Renewal (grants are leases, #1882 item 4) bumps expires_at on the existing
-- grant row in place — no lineage table; the previous expiry is not retained.

CREATE TABLE IF NOT EXISTS auth.delegation_grants (
  id              TEXT        NOT NULL PRIMARY KEY,             -- grant_{nanoid}
  agent_did       TEXT        NOT NULL,                          -- external agent the grant is issued to
  delegator_did   TEXT        NOT NULL,                          -- principal who issued the grant (user-push only)
  audience        JSONB       NOT NULL,                          -- { type: 'all' } | { type: 'dids', values: [...] }
  on_behalf_of    JSONB       NOT NULL DEFAULT '[]'::jsonb,       -- delegation chain above delegator_did, if any
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'active',         -- 'active' | 'revoked'
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Introspection hot path: does agentDid hold any active grant right now?
CREATE INDEX IF NOT EXISTS idx_delegation_grants_agent
  ON auth.delegation_grants (agent_did, status);

-- Delegator-side listing / bulk revoke.
CREATE INDEX IF NOT EXISTS idx_delegation_grants_delegator
  ON auth.delegation_grants (delegator_did, status);

-- Background expiry sweep / observability, mirroring the vault delegation
-- grants convention (migration 0063).
CREATE INDEX IF NOT EXISTS idx_delegation_grants_expires
  ON auth.delegation_grants (expires_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS auth.delegation_grant_capabilities (
  id          TEXT        NOT NULL PRIMARY KEY,                  -- gcap_{nanoid}
  grant_id    TEXT        NOT NULL REFERENCES auth.delegation_grants(id) ON DELETE CASCADE,
  capability  TEXT        NOT NULL,                              -- domain:verb scope string
  status      TEXT        NOT NULL DEFAULT 'active',             -- 'active' | 'revoked'
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_delegation_grant_capability UNIQUE (grant_id, capability)
);

-- Introspection hot path join target: WHERE grant_id = ? AND capability = ?
-- AND status = 'active'. The unique constraint above already covers
-- (grant_id, capability); this adds status so the lookup is index-only.
CREATE INDEX IF NOT EXISTS idx_delegation_grant_capabilities_lookup
  ON auth.delegation_grant_capabilities (grant_id, capability, status);
