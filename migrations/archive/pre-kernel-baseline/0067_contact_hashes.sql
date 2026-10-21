-- Migration: 0066_contact_hashes
-- Creates profile.contact_hashes for federation Sybil detection.
-- Hashes are SHA-256 of normalised (lowercase, trimmed) email/phone.
-- Plaintext contact info is stored exclusively in the vault (never here).

CREATE TABLE IF NOT EXISTS profile.contact_hashes (
  did         text        PRIMARY KEY,
  email_hash  text,
  phone_hash  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
