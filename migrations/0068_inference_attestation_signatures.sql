-- Migration: 0068_inference_attestation_signatures
-- Adds Ed25519 signing fields to inference.attestations (#1292).
--
-- The row was previously described as "Signed proof-of-history" but contained
-- no actual signature. These two columns make that true: the node signs a
-- canonical payload (id + session + owner + intentType + consentTier +
-- sourceCid + vocabularyName + signedAt) with its Ed25519 identity key and
-- stores the hex signature and the corresponding public key alongside the row.
--
-- Nullable so existing rows are preserved without backfill. New rows
-- produced by resolve.ts will always have both fields set.

ALTER TABLE inference.attestations
  ADD COLUMN IF NOT EXISTS signature    text,
  ADD COLUMN IF NOT EXISTS sender_pubkey text;
