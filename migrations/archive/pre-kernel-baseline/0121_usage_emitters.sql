-- 0121_usage_emitters.sql
-- Emitter registry + external-adapter dedupe key (#1151, external-emitters
-- half of the Agent Resource-Accounting Layer, #1147).
--
-- `usage.incurred` (migrations/0119_usage_incurred.sql) is ONE stream. Emitter
-- #1 is the completions passthrough (`source = 'inference-passthrough'`,
-- #1923/#1925, already writing rows). This migration adds the registry that
-- names every OTHER emitter allowed to write into that same stream, plus the
-- dedupe key an at-least-once external reader (tailing a local log, polling
-- an API) needs to avoid double-counting on re-run.
--
-- Doing-boundary for the three parallel tickets circling `usage.incurred`
-- (see 0119's own header): #1148 owns 0120 (`quantity`/`unit` columns, the
-- bus chain config, the clock rollup) and #1076 owns the `provider:*` /
-- `reconcile:invoice` sources (provider usage-API polling, monthly invoice
-- reconciliation). This migration is #1151's remaining scope only: the
-- registry itself, the `external_id` dedupe column + partial unique index,
-- and seeding emitter #1's own registry row. It does not touch any other
-- `usage.incurred` column.
--
-- -- usage.emitters ----------------------------------------------------------
--
-- One row per `source` value that may write into `usage.incurred`:
--   source     - the usage.incurred `source` this row governs, e.g.
--                'adapter:claude-code', 'adapter:warp'. Primary key: a
--                source can have exactly one registration.
--   reader     - how the emitter observes its own spend, e.g. 'tail-jsonl'
--                (Claude Code, #1151's reference emitter), 'push' (a tool
--                that calls the ingest endpoint directly), 'internal' (the
--                completions passthrough, which writes usage.incurred
--                directly rather than through the HTTP door).
--   issuer_did - the DID this emitter is registered by, and the identity the
--                ingest endpoint checks the calling app-token against
--                (POST /usage/api/incurred requires the caller's DID to
--                match this column, or `acting_for` below).
--   acting_for - nullable: the DID this emitter reports spend ON BEHALF OF,
--                when that differs from `issuer_did` (e.g. an org's shared
--                adapter reporting a member's spend). Also accepted as a
--                second valid caller identity at ingest time.
--   key_field  - nullable vault FIELD NAME (never a value) the reader needs
--                to authenticate itself upstream, e.g. a provider API key
--                for a future 'usage-api' reader. Same convention as
--                kernel.connectors.sealed_key_field (0114): a reference, not
--                a credential. NULL for readers that need no credential
--                (tail-jsonl reads a local file; internal needs nothing).
--   cadence    - nullable free-text cadence hint for polling/batch readers
--                (e.g. 'continuous', 'daily'); NULL for push/internal
--                readers with no fixed schedule.
--   config     - reader-specific configuration (e.g. a tail path), additive
--                and shapeless on purpose - same reasoning
--                kernel.connectors.spend_cap gave for JSONB over columns.
--   status     - 'active' | 'revoked'. The ingest endpoint refuses rows for
--                a non-active source.
--
-- -- Dedupe key --------------------------------------------------------------
--
-- An external emitter that tails a log or replays a page can re-observe the
-- same underlying event on a re-run (crash-and-resume, overlapping poll
-- windows). `external_id` is the emitter's own idempotency key for that
-- event (e.g. a Claude Code session-JSONL message uuid); the partial unique
-- index makes `(source, external_id)` the ON CONFLICT target so a re-tail
-- can never double-count. Partial (`WHERE external_id IS NOT NULL`) because
-- the passthrough emitter writes no `external_id` at all (each of its calls
-- is already exactly-once from the request/response cycle), and a partial
-- index keeps that explicit rather than incidental.

CREATE TABLE IF NOT EXISTS usage.emitters (
  source      TEXT        NOT NULL PRIMARY KEY,
  reader      TEXT        NOT NULL,
  issuer_did  TEXT        NOT NULL,
  acting_for  TEXT,
  key_field   TEXT,
  cadence     TEXT,
  config      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT        NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Owner read: every emitter a DID has registered.
CREATE INDEX IF NOT EXISTS idx_usage_emitters_issuer
  ON usage.emitters (issuer_did, status);

-- Resolve a sealed field back to its owning emitter without a scan (mirrors
-- kernel.connectors' idx_connectors_sealed_key_field, 0114).
CREATE INDEX IF NOT EXISTS idx_usage_emitters_key_field
  ON usage.emitters (key_field)
  WHERE key_field IS NOT NULL;

ALTER TABLE usage.incurred ADD COLUMN IF NOT EXISTS external_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_usage_incurred_source_external_id
  ON usage.incurred (source, external_id)
  WHERE external_id IS NOT NULL;

-- Emitter #1's own registry row, so it is discoverable the same way every
-- other emitter is, even though it writes usage.incurred directly rather
-- than through POST /usage/api/incurred. 'did:imajin:platform' is the
-- existing platform-DID literal (see migrations/0052_seed_claude_mcp_client.sql)
-- - not a new convention introduced here.
INSERT INTO usage.emitters (source, reader, issuer_did, status)
VALUES ('inference-passthrough', 'internal', 'did:imajin:platform', 'active')
ON CONFLICT (source) DO NOTHING;
