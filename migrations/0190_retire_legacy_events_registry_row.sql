-- 0190_retire_legacy_events_registry_row.sql
-- owner: kernel
-- #2808 (events extraction, part of #2529): events now runs from ima-jin/events
-- and is registered through apps.provision, so the seeded first-party row
-- `app_first_party_events` (0139) has nothing left to stand for.
--
-- Why it must not stay active: both that row and the provisioned row carry
-- token_audiences = {events}, and resolveActiveAppByAudience picks one with
-- LIMIT 1 and no ORDER BY. If it picked the legacy row, events' token mint would
-- get the first-party exemption (no scope ceiling) and lose its events:* scopes.
--
-- This only UPDATEs registry.apps — it drops no table, no column and no data, and
-- it never touches the events schema or its data (owned by the standalone app).
-- It retires the legacy row rather than deleting it, and it empties the fields
-- that would let the row answer anything:
--   status          -> 'revoked' (+ revoked_at)
--   token_audiences -> '{}'  so the audience resolves to exactly one row and a
--                            revoked row can never shadow the active one
--   slug            -> NULL  (frees the unique slug; the provisioned row owns it)
--   placements      -> '{}'  so launcher/home/auth-submenu never show two events entries
--
-- Guarded: it runs only when ANOTHER active registry.apps row already answers the
-- events audience. A node that never provisioned standalone events keeps its legacy
-- row untouched. A re-run, an already-revoked row, or an operator who already
-- cleared the slug by hand is a no-op.

UPDATE registry.apps
SET status          = 'revoked',
    revoked_at      = COALESCE(revoked_at, NOW()),
    updated_at      = NOW(),
    token_audiences = '{}'::text[],
    slug            = NULL,
    placements      = '{}'::text[]
WHERE id = 'app_first_party_events'
  AND status = 'active'
  AND slug IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM registry.apps provisioned
    WHERE provisioned.id <> 'app_first_party_events'
      AND provisioned.status = 'active'
      AND 'events' = ANY (provisioned.token_audiences)
  );
