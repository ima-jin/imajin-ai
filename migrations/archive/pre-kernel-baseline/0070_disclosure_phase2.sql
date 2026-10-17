-- 0070_disclosure_phase2.sql
-- Disclosure dashboard phase 2: contact metadata for relationship categorization
-- Issue #1220
--
-- Adds a per-subject, per-contact metadata table so the disclosure dashboard
-- can group recipients by relationship type (business / group / person /
-- collective) and show human-readable labels instead of raw DIDs.

CREATE TABLE kernel.contact_metadata (
  id               TEXT PRIMARY KEY,
  subject          TEXT NOT NULL,           -- DID of the data subject (owner)
  did              TEXT NOT NULL,           -- DID of the contact (recipient)
  label            TEXT,                    -- free-text display name, e.g. "Acme Restaurant"
  relationship_type TEXT,                  -- 'business' | 'group' | 'person' | 'collective'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_contact_metadata_subject_did UNIQUE (subject, did)
);

CREATE INDEX idx_contact_metadata_subject ON kernel.contact_metadata (subject);
