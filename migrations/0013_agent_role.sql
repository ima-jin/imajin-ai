-- Migration: Add agent role to identity_members
-- The agent role allows delegated read + limited write access:
--   - Can read owner's public + private data via X-Acting-As
--   - Can send messages on behalf
--   - Can create attestations on behalf
--   - CANNOT transfer funds, change identity settings, or manage other members
--
-- The role column is TEXT with no CHECK constraint, so this is a schema
-- documentation migration. Existing rows are unaffected.

-- Add a partial index for fast agent-role lookups (optional, idempotent)
CREATE INDEX IF NOT EXISTS idx_identity_members_role_agent
  ON auth.identity_members(identity_did, member_did)
  WHERE role = 'agent';
