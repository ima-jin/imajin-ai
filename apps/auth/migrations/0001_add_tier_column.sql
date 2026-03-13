-- Phase 0: Add tier column to auth.identities
ALTER TABLE auth.identities ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'soft';
UPDATE auth.identities SET tier = 'preliminary' WHERE public_key NOT LIKE 'soft_%';
