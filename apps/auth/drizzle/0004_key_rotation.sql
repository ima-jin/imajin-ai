-- Add key roles to identities (null = single key in all roles)
ALTER TABLE auth.identities
  ADD COLUMN IF NOT EXISTS key_roles JSONB;

-- Add key tracking to tokens
ALTER TABLE auth.tokens
  ADD COLUMN IF NOT EXISTS key_id TEXT,
  ADD COLUMN IF NOT EXISTS key_role TEXT;
