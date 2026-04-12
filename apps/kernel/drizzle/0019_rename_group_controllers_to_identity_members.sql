-- Migration 0019: Rename group_controllers → identity_members
-- Renames table + columns to be scope-neutral; prepares for #653 (role stubs)

-- Rename table (stays in auth schema)
ALTER TABLE auth.group_controllers RENAME TO identity_members;

-- Rename columns to be scope-neutral
ALTER TABLE auth.identity_members RENAME COLUMN group_did TO identity_did;
ALTER TABLE auth.identity_members RENAME COLUMN controller_did TO member_did;

-- Rename indexes
ALTER INDEX IF EXISTS idx_group_controllers_pk RENAME TO idx_identity_members_pk;
ALTER INDEX IF EXISTS idx_group_controllers_controller RENAME TO idx_identity_members_member;
