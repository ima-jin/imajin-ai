-- 0185_retire_legacy_coffee_registry_row.sql
-- owner: kernel
-- #2500 (prune apps/coffee, part of #1984): coffee now runs from ima-jin/coffee and
-- is registered through apps.provision, so the seeded first-party row
-- `app_first_party_coffee` (0139) has nothing left to stand for.
--
-- Why it must not stay active: both that row and the provisioned row carry
-- token_audiences = {coffee}, and resolveActiveAppByAudience picks one with
-- LIMIT 1 and no ORDER BY. If it picked the legacy row, coffee's token mint would
-- get the first-party exemption (no scope ceiling) and lose its coffee:* scopes.
--
-- This only UPDATEs registry.apps — it drops no table, no column and no data, and
-- it never touches the coffee schema (coffee.pages / coffee.tips stay owned by the
-- standalone app). It retires the legacy row rather than deleting it, and it empties
-- the fields that would let the row answer anything:
--   status          -> 'revoked' (+ revoked_at)
--   token_audiences -> '{}'  so the audience resolves to exactly one row and a
--                            revoked row can never shadow the active one
--   slug            -> NULL  (frees the unique slug; the provisioned row owns it)
--   placements      -> '{}'  so launcher/home/auth-submenu never show two coffee entries
--
-- Guarded: it runs only when ANOTHER active registry.apps row already answers the
-- coffee audience. A node that never provisioned standalone coffee keeps its legacy
-- row untouched, and a re-run (or an operator who already revoked it by hand) is a no-op.

UPDATE registry.apps
SET status          = 'revoked',
    revoked_at      = COALESCE(revoked_at, NOW()),
    updated_at      = NOW(),
    token_audiences = '{}'::text[],
    slug            = NULL,
    placements      = '{}'::text[]
WHERE id = 'app_first_party_coffee'
  AND status = 'active'
  AND EXISTS (
    SELECT 1
    FROM registry.apps provisioned
    WHERE provisioned.id <> 'app_first_party_coffee'
      AND provisioned.status = 'active'
      AND 'coffee' = ANY (provisioned.token_audiences)
  );
