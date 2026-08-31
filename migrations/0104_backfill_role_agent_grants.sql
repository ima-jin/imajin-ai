-- 0104_backfill_role_agent_grants.sql
-- #1887 migration step 2: "mint a wide owner-agent grant for every existing
-- role:agent member", per the #1882 Day-1 amendment settling what "wide"
-- means (issue comment, 2026-08-30):
--
--   A grant whose capabilities[] enumerates the full domain:verb vocabulary
--   (the 16 promoted MCP scopes plus kernel extensions) with
--   audience: { type: "all" }. Deliberately no wildcard scope (*:*) --
--   wideness is enumeration, not a special token.
--
-- This is a point-in-time snapshot of packages/auth/src/grant-scopes.ts's
-- GRANT_SCOPE_REGISTRY as of #1887. Plain SQL migrations cannot import the
-- TS registry, so the 19 scope strings below are enumerated literally. If
-- the registry gains capabilities later, that's a forward-looking grant
-- concern (re-issue/renew), not something this backfill needs to chase.
--
-- Target expiry: NOW() + 30 days (auth.GRANT_MAX_TTL, packages/auth/src/
-- constants.ts). Grants are leases, never perpetual authority (#1882 item
-- 4) -- backfilled grants are no exception. Existing local agents (Jin) and
-- any owner who wants to keep an agent working past 30 days must renew via
-- POST /auth/api/grants/:grantId/renew (already live from #1882, exposed in
-- the #1887 grants-view UI) before it lapses. This is intentional: it turns
-- "the migration ran" into "the honest record is scoped, expiring, and
-- renewable", not "the migration invisibly re-created perpetual authority
-- under a new table".
--
-- Idempotent: the grant id is deterministic from (delegator_did, agent_did),
-- so re-running this migration is a no-op the second time -- ON CONFLICT DO
-- NOTHING on the grant insert, and the capabilities insert only ever reads
-- from grants this exact statement just inserted (via the RETURNING CTE),
-- so a grant that already existed from a prior run never gets its
-- capabilities re-inserted (they're already there, or intentionally revoked
-- since -- either way, not this migration's business to touch again).
--
-- Both sides of the membership must be real, still-present identities and
-- the membership must be un-removed -- never manufacture a grant for a
-- dangling or already-revoked delegation.

WITH backfill_targets AS (
  SELECT DISTINCT
    im.identity_did AS delegator_did,
    im.member_did AS agent_did
  FROM auth.identity_members im
  WHERE im.role = 'agent'
    AND im.removed_at IS NULL
    AND EXISTS (SELECT 1 FROM auth.identities d WHERE d.id = im.identity_did)
    AND EXISTS (SELECT 1 FROM auth.identities a WHERE a.id = im.member_did)
),
inserted_grants AS (
  INSERT INTO auth.delegation_grants (
    id, agent_did, delegator_did, audience, on_behalf_of,
    issued_at, expires_at, status, created_at, updated_at
  )
  SELECT
    'grant_backfill_' || substr(md5(bt.delegator_did || ':' || bt.agent_did), 1, 20),
    bt.agent_did,
    bt.delegator_did,
    '{"type":"all"}'::jsonb,
    '[]'::jsonb,
    NOW(),
    NOW() + INTERVAL '30 days',
    'active',
    NOW(),
    NOW()
  FROM backfill_targets bt
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
INSERT INTO auth.delegation_grant_capabilities (id, grant_id, capability, status, created_at)
SELECT
  'gcap_backfill_' || substr(md5(g.id || ':' || cap.capability), 1, 20),
  g.id,
  cap.capability,
  'active',
  NOW()
FROM inserted_grants g
CROSS JOIN (VALUES
  -- 16 scopes promoted from the MCP OAuth surface
  ('media:read'), ('media:write'), ('media:share'),
  ('connections:read'),
  ('messages:read'), ('messages:write'),
  ('github:read'), ('github:write'), ('github:org'), ('github:actions'),
  ('warp:dispatch'),
  ('discovery:read'),
  ('inference:read'), ('inference:write'),
  ('corpus:read'), ('corpus:write'),
  -- 3 kernel extensions
  ('intros:propose'), ('events:read'), ('contacts:read')
) AS cap(capability)
ON CONFLICT (grant_id, capability) DO NOTHING;

-- Audit trail: record the backfill itself as an 'issued' event per grant, so
-- the grants-view history for a backfilled grant doesn't start blank.
INSERT INTO auth.delegation_grant_events (id, grant_id, event, capability, actor_did, created_at)
SELECT
  'gevt_backfill_' || substr(md5(g.id), 1, 20),
  g.id,
  'issued',
  NULL,
  g.delegator_did,
  g.created_at
FROM auth.delegation_grants g
WHERE g.id LIKE 'grant_backfill_%'
ON CONFLICT (id) DO NOTHING;
