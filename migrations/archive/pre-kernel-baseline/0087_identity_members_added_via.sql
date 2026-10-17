-- Migration: 0087_identity_members_added_via
-- Adds provenance to auth.identity_members (#1680).
--
-- `added_by` records WHO added a member. It does not record HOW they arrived,
-- so the Members tab can only say "Added 8/7/2026" with no context. `added_via`
-- closes that gap:
--
--   direct — added manually by a controller through the UI
--   invite — arrived via an invite code / onboard join link
--   agent  — added programmatically by an agent (opt-in bootstrap, #1442)
--   claim  — a stub claimed by the business owner
--
-- NULL means the provenance is unknown (rows written before this migration
-- that the backfill below could not classify). The UI omits the provenance
-- chip in that case rather than guessing.

ALTER TABLE auth.identity_members
  ADD COLUMN IF NOT EXISTS added_via TEXT;

-- Backfill from what the existing rows already tell us.

-- 1. Agent delegation grants bootstrapped from a captured opt-in (#1442).
UPDATE auth.identity_members
   SET added_via = 'agent'
 WHERE added_via IS NULL
   AND role = 'agent'
   AND opt_in_ref IS NOT NULL;

-- 2. Self-service joins record the group itself as the adder (onboard join
--    link / scope membership), which is the invite path.
UPDATE auth.identity_members
   SET added_via = 'invite'
 WHERE added_via IS NULL
   AND added_by = identity_did;

-- 3. Everything else that has an explicit human adder came through the UI.
UPDATE auth.identity_members
   SET added_via = 'direct'
 WHERE added_via IS NULL
   AND added_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_identity_members_added_via
  ON auth.identity_members (added_via);
