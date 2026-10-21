-- 0125_usage_billed_manual.sql
-- Widens `usage.billed` (migration 0122) for manual/backfill line items
-- (#2030, widening #1951 D4 "manual entry v1"), under the "one signed
-- inference cost to date" goal (#2029) and the COGS epic (#1075).
--
-- Migration 0122 only ever wrote `usage.billed` from the automated
-- provider-cost-API ingestion job (`source` implicitly "api", never a
-- column). `POST /usage/api/billed` (#2030) adds a second, human-driven
-- write path — manual entries or entries evidenced by an uploaded document
-- — so the table now needs to say which path wrote a row and carry that
-- path's extra fields. Never edit 0122; this is a pure addition.
--
-- `source` distinguishes the write path: 'api' (existing ingestion,
-- DEFAULT so every pre-existing row backfills correctly), 'manual'
-- (number-only entry), 'document' (entry backed by an uploaded receipt/
-- invoice asset). `granularity` gains a third value for this path,
-- 'manual' (alongside the existing 'day'/'month' from #1076) — a backfill
-- entry's period is whatever the submitter says, not a clock-aligned
-- pull window, so it deliberately does NOT participate in the by-day
-- `usage.incurred` reconciliation (`lib/usage/reconciliation.ts` filters
-- `granularity = 'day'`), which only ever compares OUR meter against the
-- provider's own settled-day statement.
--
-- `currency` is new (previously implicit USD via `billed_usd`); stored
-- verbatim per #2030's scope note (`packages/money` FX, #1950, is out of
-- scope). `amount_minor` keeps the submitter's original minor-unit amount
-- alongside the existing `billed_usd` dollar projection (best-effort
-- amount_minor / 100 — exact for USD cents, approximate for any other
-- currency, since there is no FX/decimal-precision table here).
--
-- `evidence_asset_id` / `evidence_content_hash` back the 'document' source:
-- a reference to the uploaded `media.assets` row and a snapshot of its
-- content hash (`media.assets.hash`) at write time, per #1951 D3 (a
-- document is optional evidence bound to the line item by content hash,
-- never the record itself). No FK constraint — same "a usage row must
-- never fail to write because a projection row raced it" rationale
-- 0119/0122 already established for connector_id/model.

ALTER TABLE usage.billed ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'api';
ALTER TABLE usage.billed ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE usage.billed ADD COLUMN IF NOT EXISTS amount_minor BIGINT;
ALTER TABLE usage.billed ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE usage.billed ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE usage.billed ADD COLUMN IF NOT EXISTS evidence_asset_id TEXT;
ALTER TABLE usage.billed ADD COLUMN IF NOT EXISTS evidence_content_hash TEXT;

-- Manual/backfill read: a principal's non-api billed rows, newest first —
-- the read API (#2030) and any future manual-entry list view key off this.
CREATE INDEX IF NOT EXISTS idx_usage_billed_source
  ON usage.billed (principal_did, source, period_start);
