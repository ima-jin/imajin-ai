-- Migration: Add agent_pricing JSONB column to profile.profiles
-- Stores the AgentPricingManifest for agent identities.

ALTER TABLE profile.profiles ADD COLUMN IF NOT EXISTS agent_pricing JSONB;
