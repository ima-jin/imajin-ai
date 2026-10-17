-- #1154: Add lore_ref column to media.assets
-- Stores the Lore revision hash (64-char SHA-256 hex) for each uploaded asset.
-- Nullable — assets uploaded before Lore integration will have NULL.
-- This column is the storage pointer for the Lore blob store (Layer B).
-- The DFOS CID (Layer A identity, #1122) will be a separate column when that ships.
ALTER TABLE media.assets
  ADD COLUMN IF NOT EXISTS lore_ref TEXT;
