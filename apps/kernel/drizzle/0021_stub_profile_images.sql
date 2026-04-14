-- Banner columns on profiles
ALTER TABLE profile.profiles ADD COLUMN IF NOT EXISTS banner text;
ALTER TABLE profile.profiles ADD COLUMN IF NOT EXISTS banner_asset_id text;

-- Gallery images table
CREATE TABLE IF NOT EXISTS profile.profile_images (
  id text PRIMARY KEY,
  did text NOT NULL,
  url text NOT NULL,
  caption text,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  created_by text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_images_did ON profile.profile_images (did);
