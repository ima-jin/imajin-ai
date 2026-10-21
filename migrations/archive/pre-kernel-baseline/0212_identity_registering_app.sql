-- 0212_identity_registering_app.sql
-- owner: kernel
-- Verified registering-app provenance. Legacy rows deliberately remain NULL.
ALTER TABLE auth.identities
  ADD COLUMN IF NOT EXISTS registered_by_app_did TEXT;
