-- Migration: Add last_seen_at to profiles for online presence tracking
-- Issue: #80

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Create an index for efficient presence queries
CREATE INDEX IF NOT EXISTS idx_profiles_last_seen_at ON profiles(last_seen_at);
