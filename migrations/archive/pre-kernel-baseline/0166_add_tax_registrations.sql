-- 0166_add_tax_registrations.sql
-- owner: kernel
-- #2420 — tax_registrations[] on the business profile.
--
-- One profile may hold multiple tax registrations (a business can be
-- registered in several jurisdictions), so this is a jsonb array rather
-- than scalar columns:
--   [{ jurisdiction: 'CA-ON', kind: 'GST/HST'|'QST'|'PST'|'VAT', number: string, label?: string }]
--
-- Format validation (CRA Business Number, QST, VAT, PST) lives in
-- application code (apps/kernel/src/lib/profile/tax-registrations.ts) —
-- no external verification, no DB-level CHECK constraint on `number`.
--
-- Public by design: these print on invoices/pay pages, so the public
-- profile read (GET /profile/api/profile/:id) never filters this field
-- the way it filters other broker-gated metadata.
--
-- ADDITIVE ONLY.

ALTER TABLE profile.profiles
  ADD COLUMN IF NOT EXISTS tax_registrations jsonb NOT NULL DEFAULT '[]';
