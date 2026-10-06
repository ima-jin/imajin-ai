-- 0174_profile_etransfer_email.sql
-- owner: kernel
-- #2665 — e-Transfer receiving email on the business profile.
--
-- Sits next to `tax_registrations` (0166): an owner-editable field on the
-- business profile. The e-Transfer pay-in option on /pay/r/:handle only
-- appears for an issuer whose profile has this set; NULL (the default)
-- means the issuer does not accept e-Transfer.
--
-- Unlike tax_registrations it is NOT public profile data: the profile read
-- returns it to the owner only, and a payer sees it solely in the
-- instructions for a request they chose to pay by e-Transfer.
--
-- Format validation lives in application code
-- (apps/kernel/src/lib/profile/etransfer-email.ts) — no DB-level CHECK.
--
-- ADDITIVE ONLY.

ALTER TABLE profile.profiles
  ADD COLUMN IF NOT EXISTS etransfer_email text;
