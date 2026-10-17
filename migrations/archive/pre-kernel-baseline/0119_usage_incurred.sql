-- 0119_usage_incurred.sql
-- The `usage.incurred` stream — Phase 3 of the inference connectors epic
-- (#1922), sub-issue #1923.
--
-- `inference.usage` is where this table started, but it is the same table
-- three tickets have been circling: #1923 (this one — control/spend caps),
-- #1148 + #1147 (Agent Resource-Accounting Layer — the `usage.incurred`
-- primitive: emitter/resource-agnostic, system-class attestation, clock
-- rollup), and #1151 (external emitters: Warp / Claude Code / provider-usage
-- APIs / invoice reconciliation). Decision: ONE stream, named per #1147's
-- spec, before this ever ships with rows in it — renaming a table after it
-- has data is a migration; renaming it before is a rename.
--
-- This passthrough is emitter #1 (`source = 'inference-passthrough'`).
-- Other emitters land in the same table going forward:
--   - #1151's external emitters (Warp, Claude Code, provider-usage-API
--     pulls) — their own `source` values.
--   - #1076's reconciliation-against-provider-invoice pass — `source` values
--     shaped like `reconcile:*` / `provider:*`.
-- `resource` (`model:* | tool:* | infra:* | external:*`) is the cross-emitter
-- typed discriminator #1147 specifies; this emitter always writes
-- `model:{provider}/{model}`. `provider` and `model` stay as their own
-- columns alongside it — the spend-cap read path and its indexes key off
-- them directly, so `resource` is additive (the cross-emitter join key), not
-- a replacement.
--
-- Quantity/unit, attestation class, and the chain/rollup are #1148's
-- remaining scope and are additive later — out of scope for this migration,
-- which only settles the name and the two discriminators (the
-- expensive-to-change part).
--
-- Division of responsibility, unchanged from the original design:
--
--   usage.incurred      — owns the granular, token-level record (this table).
--   pay.transactions     — owns the money (`service = 'inference'`, extended in
--                          application code; no schema change needed there, see
--                          apps/kernel/src/db/schemas/pay.ts — `service` and
--                          `type: 'query'` were already declared for this).
--   pay.balance_rollups  — owns the daily aggregated burn-down per (did, date,
--                          service); also pre-existing, no schema change needed.
--
-- `connector_id` references `kernel.connectors.id` (#1924, migration 0114) —
-- the specific (owner_did, provider) registry row that supplied the sealed
-- credential for this call. That row is also where the Phase 3 spend cap
-- lives (`kernel.connectors.spend_cap`), so a cap-enforcement read and a
-- usage-ledger write both key off the same id. No FK constraint: the registry
-- is a shadow projection (0114's own words — "SHADOW, do not replace"), and a
-- usage row must never fail to write because a projection row raced it.
--
-- `tokens_in` / `tokens_out` / `cost_usd` are nullable: the OpenAI-compatible
-- passthrough (Gemini/xAI/OpenAI/Moonshot/Z.ai) is a raw byte passthrough by
-- design (#1925's adapter header), so a provider that omits `usage` from its
-- response/stream (despite `stream_options.include_usage` being requested)
-- still gets a usage row for call-count/session/turn/agent attribution — just
-- without token/cost figures. A degraded row beats a missing one.

CREATE SCHEMA IF NOT EXISTS usage;

CREATE TABLE IF NOT EXISTS usage.incurred (
  id              TEXT        NOT NULL PRIMARY KEY,      -- usage_{nanoid}
  session_id      TEXT,                                   -- X-Session-Id header (OpenClaw); null when the caller sent none
  turn_id         TEXT,                                   -- X-Turn-Id header; null when the caller sent none
  principal_did   TEXT        NOT NULL,                   -- owner DID whose sealed connector card supplied the credential (brain.ts credentialDid)
  agent_did       TEXT,                                   -- invoking app DID (onBehalfOf); null when the owner called directly
  source          TEXT        NOT NULL DEFAULT 'inference-passthrough', -- #1147 emitter id; every other emitter (#1151) and reconciliation pass (#1076) names its own
  resource        TEXT        NOT NULL,                   -- #1147 typed discriminator: 'model:*' | 'tool:*' | 'infra:*' | 'external:*' — this emitter always writes 'model:{provider}/{model}'
  provider        TEXT        NOT NULL,                   -- BRAIN_CONNECTORS id, e.g. 'xai' | 'anthropic' | 'gemini' | 'openai' | 'moonshot' | 'zai'
  connector_id    TEXT,                                   -- kernel.connectors.id this call resolved credentials from (0114); null if the row could not be resolved
  model           TEXT        NOT NULL,
  tokens_in       INTEGER,                                -- null when the upstream response never reported usage
  tokens_out      INTEGER,
  cost_usd        NUMERIC(20, 8),                         -- null when tokens are unknown or the model has no pricing entry
  transaction_id  TEXT,                                   -- pay.transactions.id this call's spend was recorded under; null when cost is unknown
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dashboard burn-down: a principal's own spend, newest first.
CREATE INDEX IF NOT EXISTS idx_usage_incurred_principal
  ON usage.incurred (principal_did, created_at);

-- Burn-down by agent (delegated caller), when one is present.
CREATE INDEX IF NOT EXISTS idx_usage_incurred_agent
  ON usage.incurred (agent_did, created_at)
  WHERE agent_did IS NOT NULL;

-- Burn-down by session / turn (OpenClaw-supplied correlation ids).
CREATE INDEX IF NOT EXISTS idx_usage_incurred_session
  ON usage.incurred (session_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_incurred_turn
  ON usage.incurred (turn_id)
  WHERE turn_id IS NOT NULL;

-- Spend-cap enforcement: sum cost for one connector registry row within a
-- window, keyed exactly the way the kernel-side cap check queries it.
CREATE INDEX IF NOT EXISTS idx_usage_incurred_connector
  ON usage.incurred (connector_id, created_at)
  WHERE connector_id IS NOT NULL;

-- Operator read: overall volume over time.
CREATE INDEX IF NOT EXISTS idx_usage_incurred_created
  ON usage.incurred (created_at);
