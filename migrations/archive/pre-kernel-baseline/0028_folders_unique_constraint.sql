-- Deduplicate folders: keep the oldest folder for each (owner_did, name, parent_id)
-- and update asset references before deleting duplicates.
-- Then add a unique index to prevent future races.

CREATE TEMP TABLE folder_dedup_map AS
WITH ranked AS (
  SELECT
    id,
    owner_did,
    name,
    COALESCE(parent_id, '') as parent_key,
    ROW_NUMBER() OVER (PARTITION BY owner_did, name, COALESCE(parent_id, '') ORDER BY created_at ASC, id ASC) as rn
  FROM media.folders
)
SELECT r.id as dupe_id, k.id as keeper_id
FROM ranked r
JOIN ranked k ON r.owner_did = k.owner_did AND r.name = k.name AND r.parent_key = k.parent_key
WHERE r.rn > 1 AND k.rn = 1;

-- Update junction table references
UPDATE media.asset_folders af
SET folder_id = m.keeper_id
FROM folder_dedup_map m
WHERE af.folder_id = m.dupe_id;

-- Update assets.folder_id references
UPDATE media.assets a
SET folder_id = m.keeper_id
FROM folder_dedup_map m
WHERE a.folder_id = m.dupe_id;

-- Delete duplicate folders
DELETE FROM media.folders f
USING folder_dedup_map m
WHERE f.id = m.dupe_id;

DROP TABLE folder_dedup_map;

-- Add unique index to prevent future duplicate folders
CREATE UNIQUE INDEX idx_folders_unique_name ON media.folders (owner_did, name, (COALESCE(parent_id, '')));
