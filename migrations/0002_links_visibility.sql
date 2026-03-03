-- Add visibility column to links table
ALTER TABLE links ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';

-- Add comment explaining the field
COMMENT ON COLUMN links.visibility IS 'Link visibility: public (visible to all) or authenticated (visible to logged-in users only)';
