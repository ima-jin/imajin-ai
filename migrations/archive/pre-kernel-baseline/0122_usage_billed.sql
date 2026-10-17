-- 0122_usage_billed.sql
-- Stage 1 of #1076 (COGS: live provider cost ingestion + key-per-client
-- billing) — the provider-billed side and its reconciliation against our own
-- meter.
--
-- Framing (maintainer ruling, 2026-09-02, issue #1076 comment): `usage.incurred`
-- (migration 0119) is OUR meter — rows we computed ourselves. This table is
-- the COUNTERPARTY'S STATEMENT: what the provider's own usage/cost API says
-- we were actually charged. The two are never merged — `usage.billed` is a
-- separate, standalone table, reconciled against `usage.incurred` at READ
-- time (see the `/usage/api/reconciliation` route). The drift between
-- computed and billed is the deliverable: a mispriced rate card, a leaking
-- key, or an unmetered surface all show up as a gap here.
--
-- This absorbs #1151's provider-usage-API-pull and invoice-reconciliation
-- items for Anthropic and OpenAI. It does NOT touch `usage.incurred` (owned
-- by #1148: quantity/unit, chain config, rollup — migration 0120) or the
-- emitter registry (owned by #1151: `usage.emitters`, external_id, ingest
-- endpoint — migration 0121). Key-per-client isolation (Stage 2 of #1076)
-- and additional provider adapters (Moonshot, xAI, Gemini, Z.ai) are also
-- out of scope here.
--
-- One row per (principal, provider, period, granularity, model) line item as
-- reported by the provider's own admin/billing API. `raw` keeps the
-- provider's original line item verbatim for audit/debugging — normalized
-- columns are a projection of it, not a replacement.

CREATE SCHEMA IF NOT EXISTS usage;

CREATE TABLE IF NOT EXISTS usage.billed (
  id              TEXT          NOT NULL PRIMARY KEY,      -- billed_{nanoid}
  principal_did   TEXT          NOT NULL,                   -- owner DID whose sealed admin/billing key was used
  provider        TEXT          NOT NULL,                   -- 'anthropic' | 'openai' (others land here later, unchanged shape)
  period_start    TIMESTAMPTZ   NOT NULL,
  period_end      TIMESTAMPTZ   NOT NULL,
  granularity     TEXT          NOT NULL,                   -- 'day' | 'month'
  model           TEXT,                                     -- nullable: providers report per-model where available, org-wide otherwise
  tokens_in       BIGINT,
  tokens_out      BIGINT,
  billed_usd      NUMERIC(20, 8),
  raw             JSONB,                                    -- the provider's line item exactly as returned, for audit
  fetched_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Idempotent re-fetch: a daily sweep re-pulls the same (principal, provider,
-- period, granularity, model) window repeatedly (yesterday settles, this
-- month's month-to-date bucket is re-pulled every run), and each pull must
-- upsert in place rather than accumulate duplicate rows.
--
-- COALESCE(model, '') rather than a bare `model` column: two NULLs are never
-- equal under a plain UNIQUE constraint/index, so an org-wide (no
-- per-model breakdown) line item would insert a fresh duplicate row on every
-- re-fetch instead of updating the same one.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_usage_billed_period
  ON usage.billed (principal_did, provider, period_start, granularity, COALESCE(model, ''));

-- Reconciliation read: this principal's billed rows for a provider, newest first.
CREATE INDEX IF NOT EXISTS idx_usage_billed_principal
  ON usage.billed (principal_did, provider, period_start);

-- Operator read: overall billed volume over time.
CREATE INDEX IF NOT EXISTS idx_usage_billed_fetched
  ON usage.billed (fetched_at);
