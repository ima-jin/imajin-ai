-- Migration: add nostr_sig column to auth.attestations
-- Stores the secp256k1 Schnorr (BIP-340) proof-of-Nostr-key-control
-- for imajin/nostr-key-binding attestations (#1411).

ALTER TABLE auth.attestations
  ADD COLUMN IF NOT EXISTS nostr_sig TEXT;
