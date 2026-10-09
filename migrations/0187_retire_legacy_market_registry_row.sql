-- 0187_retire_legacy_market_registry_row.sql
-- owner: kernel
-- #2512 (prune apps/market, part of #1989): market now runs from ima-jin/market and
-- is registered through apps.provision, so the seeded first-party row
-- `app_first_party_market` (0139) has nothing left to stand for.
--
-- Why it must not stay active: both that row and the provisioned row carry
-- token_audiences = {market}, and resolveActiveAppByAudience picks one with
-- LIMIT 1 and no ORDER BY. If it picked the legacy row, market's token mint would
-- get the first-party exemption (no scope ceiling) and lose its market:* scopes.
--
-- This only UPDATEs registry.apps — it drops no table, no column and no data,
-- and touches nothing in the market schema. It retires the legacy row rather than
-- deleting it, and it empties the fields that would let the row answer anything:
--   status          -> 'revoked' (+ revoked_at)
--   token_audiences -> '{}'  so the audience resolves to exactly one row and a
--                            revoked row can never shadow the active one
--   slug            -> NULL  (frees the unique slug; the provisioned row owns it)
--   placements      -> '{}'  so launcher/home/auth-submenu never show two market entries
--
-- Guarded: it runs only when ANOTHER active registry.apps row already answers the
-- market audience. A node that never provisioned standalone market keeps its legacy
-- row untouched, and a re-run (or an operator who already revoked it by hand) is a no-op.

UPDATE registry.apps
SET status          = 'revoked',
    revoked_at      = COALESCE(revoked_at, NOW()),
    updated_at      = NOW(),
    token_audiences = '{}'::text[],
    slug            = NULL,
    placements      = '{}'::text[]
WHERE id = 'app_first_party_market'
  AND status = 'active'
  AND EXISTS (
    SELECT 1
    FROM registry.apps provisioned
    WHERE provisioned.id <> 'app_first_party_market'
      AND provisioned.status = 'active'
      AND 'market' = ANY (provisioned.token_audiences)
  );
