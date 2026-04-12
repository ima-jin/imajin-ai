-- Migration 0017: Identity scopes (#346)
-- Consolidates identities.type + group_identities.scope into scope + subtype on identities.
-- group_identities will be dropped in the follow-up migration (0018, WO2).

-- Step 1: Add new columns
ALTER TABLE auth.identities ADD COLUMN IF NOT EXISTS scope TEXT;
ALTER TABLE auth.identities ADD COLUMN IF NOT EXISTS subtype TEXT;

-- Step 2: Backfill scope + subtype from existing type
UPDATE auth.identities SET scope = 'actor', subtype = type WHERE type IN ('human', 'agent', 'presence', 'node');
UPDATE auth.identities SET scope = 'business' WHERE type = 'org';
UPDATE auth.identities SET scope = 'community' WHERE type = 'community';
UPDATE auth.identities SET scope = 'family' WHERE type = 'family';
-- Any remaining nulls: default to actor
UPDATE auth.identities SET scope = 'actor' WHERE scope IS NULL;

-- Step 3: Make scope NOT NULL now that it is backfilled
ALTER TABLE auth.identities ALTER COLUMN scope SET NOT NULL;

-- Step 4: Drop old type column
ALTER TABLE auth.identities DROP COLUMN IF EXISTS type;

-- Step 5: Index on scope
CREATE INDEX IF NOT EXISTS idx_identities_scope ON auth.identities (scope);
