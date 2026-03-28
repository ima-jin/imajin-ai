-- Migration: consolidate feature toggles into JSONB column
-- Replaces: inference_enabled (bool), show_market_items (bool), show_events (bool)
-- Also moves metadata keys (links, coffee, dykil, learn) into feature_toggles

ALTER TABLE profile.profiles
  ADD COLUMN feature_toggles jsonb NOT NULL DEFAULT '{}';

-- Migrate existing boolean columns + metadata keys into feature_toggles
UPDATE profile.profiles
SET feature_toggles = jsonb_strip_nulls(jsonb_build_object(
  'inference_enabled', inference_enabled,
  'show_market_items', show_market_items,
  'show_events',       show_events,
  'links',             metadata->>'links',
  'coffee',            metadata->>'coffee',
  'dykil',             metadata->>'dykil',
  'learn',             metadata->>'learn'
));

-- Remove migrated keys from metadata
UPDATE profile.profiles
SET metadata = metadata - 'links' - 'coffee' - 'dykil' - 'learn'
WHERE metadata IS NOT NULL;

-- Drop the old boolean columns
ALTER TABLE profile.profiles
  DROP COLUMN inference_enabled,
  DROP COLUMN show_market_items,
  DROP COLUMN show_events;
