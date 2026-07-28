-- 0074_soft_did_delegation_bootstrap.sql
-- Soft-DID delegation bootstrap (Issue #1442).
--
-- Two schema additions that enable partner-writable consent via acting-for,
-- authorized by the traveler's opt-in at get-or-create time (#1230).
--
-- 1. kernel.consent_grants.issuer — records WHO wrote the grant on the
--    subject's behalf.  When a partner app writes consent under X-Acting-For
--    the issuer is the app DID (not the traveler), making the audit trail
--    explicit: issuer = app, subject = traveler.
--    NULL for grants written by the subject themselves (backward-compatible).
--
-- 2. auth.identity_members.opt_in_ref — stores the opaque reference to the
--    traveler's captured opt-in event that authorized the agent delegation.
--    The chain: consent_grant.issuer → identity_members row
--    (identity_did=traveler, member_did=app) → opt_in_ref.
--    NULL for controller entries that were not created via opt-in bootstrap.

ALTER TABLE kernel.consent_grants
  ADD COLUMN IF NOT EXISTS issuer TEXT;

ALTER TABLE auth.identity_members
  ADD COLUMN IF NOT EXISTS opt_in_ref TEXT;
