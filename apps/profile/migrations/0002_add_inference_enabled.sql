-- Add inference_enabled to profiles for presence toggle
ALTER TABLE profile.profiles ADD COLUMN IF NOT EXISTS inference_enabled BOOLEAN NOT NULL DEFAULT false;
