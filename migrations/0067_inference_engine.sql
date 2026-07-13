-- Migration: 0067_inference_engine
-- Creates the inference schema for the Intention Inference Engine (#1198).
--
-- inference.sessions  — one row per gesture pipeline run (capture → resolve).
-- inference.attestations — signed proof-of-history per resolved intent.

CREATE SCHEMA IF NOT EXISTS inference;

-- ---------------------------------------------------------------------------
-- inference.sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inference.sessions (
  id                  text        PRIMARY KEY,
  owner_did           text        NOT NULL,
  vocabulary_name     text        NOT NULL,
  asset_id            text        NOT NULL,
  transcript          text,
  priors              jsonb,
  candidate_intents   jsonb,
  chosen_intent_type  text,
  consent_tier        text,
  -- State machine: capturing → inferring → pending_confirm | resolving → resolved | failed
  status              text        NOT NULL DEFAULT 'capturing',
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inference_sessions_owner
  ON inference.sessions (owner_did);
CREATE INDEX IF NOT EXISTS idx_inference_sessions_asset
  ON inference.sessions (asset_id);
CREATE INDEX IF NOT EXISTS idx_inference_sessions_status
  ON inference.sessions (status);
CREATE INDEX IF NOT EXISTS idx_inference_sessions_created
  ON inference.sessions (created_at);

-- ---------------------------------------------------------------------------
-- inference.attestations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inference.attestations (
  id                  text        PRIMARY KEY,
  session_id          text        NOT NULL,
  owner_did           text        NOT NULL,
  vocabulary_name     text        NOT NULL,
  intent_type         text        NOT NULL,
  consent_tier        text        NOT NULL,
  confidence          real,
  resolution_receipt  jsonb       NOT NULL,
  source_asset_id     text        NOT NULL,
  source_cid          text,
  dfos_event_id       text,
  signed_at           timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inference_attestations_owner
  ON inference.attestations (owner_did);
CREATE INDEX IF NOT EXISTS idx_inference_attestations_session
  ON inference.attestations (session_id);
CREATE INDEX IF NOT EXISTS idx_inference_attestations_source_asset
  ON inference.attestations (source_asset_id);
CREATE INDEX IF NOT EXISTS idx_inference_attestations_signed_at
  ON inference.attestations (signed_at);
