-- 0103_delegation_grant_audit.sql
-- Grants-view read surface (#1887 migration step 5), building on #1882's
-- auth.delegation_grants / auth.delegation_grant_capabilities (migration
-- 0099). Adds exactly what the read-surface spec asks for that #1882 did
-- not already carry:
--
--   - delegation_grants.last_used_at: bumped by introspectGrant() on every
--     authorized outcome (any capability). Answers "when did this grant
--     last actually do something" without waiting on #1884's event surface
--     or an unsettled dual-stamp-on-every-action design (#1882's "grants as
--     attestations?" question is explicitly still open).
--   - delegation_grant_events: the grant lifecycle audit trail
--     (issued/renewed/revoked/capability_revoked), written directly by
--     apps/kernel/src/lib/auth/grants.ts's own lifecycle functions. This is
--     narrower than a general delegated-action log on purpose -- it never
--     tries to record what an agent DID with a capability, only what
--     happened to the grant itself. Revoked grants keep their full history
--     row set (ON DELETE CASCADE only fires if the parent grant row itself
--     is deleted, which nothing in this codebase does).

ALTER TABLE auth.delegation_grants
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS auth.delegation_grant_events (
  id          TEXT        NOT NULL PRIMARY KEY,                  -- gevt_{nanoid}
  grant_id    TEXT        NOT NULL REFERENCES auth.delegation_grants(id) ON DELETE CASCADE,
  event       TEXT        NOT NULL,                              -- 'issued' | 'renewed' | 'revoked' | 'capability_revoked'
  capability  TEXT,                                               -- set only for 'capability_revoked'
  actor_did   TEXT        NOT NULL,                              -- the delegator who performed the action
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Grants-view detail read: history for one grant, newest first.
CREATE INDEX IF NOT EXISTS idx_delegation_grant_events_grant
  ON auth.delegation_grant_events (grant_id, created_at);
