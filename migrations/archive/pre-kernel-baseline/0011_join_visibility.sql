-- Add join visibility settings to forest_config
ALTER TABLE profile.forest_config
  ADD COLUMN IF NOT EXISTS join_visibility text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS join_network_depth integer NOT NULL DEFAULT 2;

-- Constraint: visibility must be one of the valid values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'forest_config_join_visibility_check'
  ) THEN
    ALTER TABLE profile.forest_config
      ADD CONSTRAINT forest_config_join_visibility_check
      CHECK (join_visibility IN ('open', 'network', 'invite'));
  END IF;
END $$;

-- Constraint: depth must be 1-3
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'forest_config_join_network_depth_check'
  ) THEN
    ALTER TABLE profile.forest_config
      ADD CONSTRAINT forest_config_join_network_depth_check
      CHECK (join_network_depth BETWEEN 1 AND 3);
  END IF;
END $$;
