-- Migration 0018: Drop profiles.display_type + auth.group_identities (#346 WO2)
-- profile.display_type is superseded by auth.identities.scope + subtype (see 0017).
-- group_identities table was already stopped from receiving new writes in WO1; drop it now.

-- Drop display_type column (index is dropped automatically by PostgreSQL)
ALTER TABLE profile.profiles DROP COLUMN IF EXISTS display_type;

-- Explicitly drop the index in case it survived in some environments
DROP INDEX IF EXISTS profile.idx_profiles_display_type;

-- Drop group_identities table (no longer written to after WO1)
DROP TABLE IF EXISTS auth.group_identities;
