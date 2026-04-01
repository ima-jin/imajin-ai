-- Migration: add contact_email to auth.identities (issue #546)
-- Stores billing/notification email sourced from Stripe or onboard flow.
ALTER TABLE auth.identities
  ADD COLUMN IF NOT EXISTS contact_email TEXT;
