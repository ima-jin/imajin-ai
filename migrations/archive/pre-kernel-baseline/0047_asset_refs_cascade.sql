-- #1122 Bundle 1: Fix asset_references FK — add ON DELETE CASCADE
-- Previously had NO ACTION, which would block hard-deletes and orphan rows
-- on any future hard-delete admin operations. With soft-delete now the default
-- (status='deleted'), the FK fires only on explicit hard-deletes during data
-- cleanup. CASCADE ensures references are cleaned up automatically in those cases.
ALTER TABLE media.asset_references
  DROP CONSTRAINT IF EXISTS asset_references_asset_id_fkey;

ALTER TABLE media.asset_references
  ADD CONSTRAINT asset_references_asset_id_fkey
    FOREIGN KEY (asset_id)
    REFERENCES media.assets(id)
    ON DELETE CASCADE;
