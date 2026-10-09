-- 0184_retire_legacy_learn_registry_row.sql
-- owner: kernel
-- #2503 (prune apps/learn, part of #1987): learn now runs from ima-jin/learn and
-- is registered through apps.provision, so the seeded first-party row
-- `app_first_party_learn` (0139) has nothing left to stand for.
--
-- Why it must not stay active: both that row and the provisioned row carry
-- token_audiences = {learn}, and resolveActiveAppByAudience picks one with
-- LIMIT 1 and no ORDER BY. If it picked the legacy row, learn's token mint would
-- get the first-party exemption (no scope ceiling) and lose its learn:* scopes.
--
-- This only UPDATEs registry.apps — it drops no table, no column and no data,
-- and touches nothing in the learn schema. It retires the legacy row rather than
-- deleting it, and it empties the fields that would let the row answer anything:
--   status          -> 'revoked' (+ revoked_at)
--   token_audiences -> '{}'  so the audience resolves to exactly one row and a
--                            revoked row can never shadow the active one
--   slug            -> NULL  (frees the unique slug; the provisioned row owns it)
--   placements      -> '{}'  so launcher/home/auth-submenu never show two learn entries
--
-- Guarded: it runs only when ANOTHER active registry.apps row already answers the
-- learn audience. A node that never provisioned standalone learn keeps its legacy
-- row untouched, and a re-run (or an operator who already revoked it by hand) is a no-op.

UPDATE registry.apps
SET status          = 'revoked',
    revoked_at      = COALESCE(revoked_at, NOW()),
    updated_at      = NOW(),
    token_audiences = '{}'::text[],
    slug            = NULL,
    placements      = '{}'::text[]
WHERE id = 'app_first_party_learn'
  AND status = 'active'
  AND EXISTS (
    SELECT 1
    FROM registry.apps provisioned
    WHERE provisioned.id <> 'app_first_party_learn'
      AND provisioned.status = 'active'
      AND 'learn' = ANY (provisioned.token_audiences)
  );
