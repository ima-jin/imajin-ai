-- 0152_delegate_grant_bearers.sql
-- owner: kernel
--
-- #2252: delegate-grant bearer credential for static-header foreign clients
-- (Meta Muse consumer connector / Muse Code) that cannot complete our
-- OAuth+PKCE dance. Never a PAT (NOT-PAT rule, #1340) — a scoped, revocable,
-- sliding-expiry bearer minted only after an operator-countersigned decision
-- on the existing /jin operator-approvals rail (#2084 signing roles,
-- mirroring the vault:* proposal chain, PR #2258's approvals-execution.ts).
--
-- KNOCK -> APPROVE -> USE -> REVOKE:
--   auth.delegate_grant_requests — the pending KNOCK, bound to
--   {principal_did, client_label, purpose, scopes, surfaces}. Pends 24h then
--   expires if never decided.
--   auth.delegate_grant_bearers — the CREDENTIAL + the RELATION as one
--   object (static-header clients cannot refresh, so the bearer lives
--   exactly as long as the grant). token_hash is a plain sha256 of a
--   high-entropy opaque secret (matching the existing OAuth
--   authorization-code/refresh-token pattern in
--   apps/kernel/src/lib/mcp/oauth-config.ts) — erased to NULL on revoke
--   (tombstone: the row survives, the credential does not).
--
-- ADDITIVE ONLY.

CREATE TABLE IF NOT EXISTS auth.delegate_grant_requests (
  id TEXT PRIMARY KEY,
  principal_did TEXT NOT NULL,
  client_label TEXT NOT NULL,
  purpose TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  surfaces JSONB NOT NULL DEFAULT '[]'::jsonb,
  sliding_window_days INTEGER NOT NULL DEFAULT 90,
  status TEXT NOT NULL DEFAULT 'pending',
  approval_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_delegate_grant_requests_principal
  ON auth.delegate_grant_requests (principal_did, status);

CREATE INDEX IF NOT EXISTS idx_delegate_grant_requests_approval
  ON auth.delegate_grant_requests (approval_id);

CREATE TABLE IF NOT EXISTS auth.delegate_grant_bearers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES auth.delegate_grant_requests(id),
  principal_did TEXT NOT NULL,
  client_label TEXT NOT NULL,
  purpose TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  surfaces JSONB NOT NULL DEFAULT '[]'::jsonb,
  token_hash TEXT,
  sliding_window_days INTEGER NOT NULL DEFAULT 90,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  hard_cap_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  approval_id TEXT NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_delegate_grant_bearers_token_hash
  ON auth.delegate_grant_bearers (token_hash);

CREATE INDEX IF NOT EXISTS idx_delegate_grant_bearers_principal
  ON auth.delegate_grant_bearers (principal_did, status);

CREATE INDEX IF NOT EXISTS idx_delegate_grant_bearers_request
  ON auth.delegate_grant_bearers (request_id);

-- Bus event chains (#2252), mirroring the agent.reach pattern in migration
-- 0151: every knock/issue/use/revoke/denial lands a durable, queryable row
-- in kernel.audit_log without a new visibility primitive. Kept in sync with
-- the packages/bus/src/config.ts DEFAULTS entries.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'access.knock.requested',
  NULL,
  '[{"type":"audit-log","config":{"fields":["requestId","principalDid","clientLabel","purpose","scopes","surfaces"]},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'access.bearer.issued',
  NULL,
  '[{"type":"audit-log","config":{"fields":["bearerId","requestId","principalDid","clientLabel","purpose","scopes","surfaces","expiresAt","hardCapAt"]},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'access.bearer.used',
  NULL,
  '[{"type":"audit-log","config":{"fields":["bearerId","principalDid","surface"]},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'access.bearer.denied',
  NULL,
  '[{"type":"audit-log","config":{"fields":["bearerId","principalDid","surface","reason"]},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'access.bearer.revoked',
  NULL,
  '[{"type":"audit-log","config":{"fields":["bearerId","principalDid","clientLabel","revokedBy"]},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
