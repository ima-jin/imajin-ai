-- 0118_inference_usage.sql
-- Per-turn metering ledger — Phase 3 of the inference connectors epic
-- (#1922), sub-issue #1923.
--
-- Every call through the completions passthrough (`POST /infer/v1/chat/completions`,
-- #1925) writes ONE row here: the granular, token-level record of that call.
-- This is deliberately a NEW table, not a column crammed into
-- `pay.transactions.metadata` — the issue is explicit about the division of
-- responsibility:
--
--   inference.usage   — owns the granular, token-level record (this table).
--   pay.transactions  — owns the money (`service = 'inference'`, extended in
--                       application code; no schema change needed there, see
--                       apps/kernel/src/db/schemas/pay.ts — `service` and
--                       `type: 'query'` were already declared for this).
--   pay.balance_rollups — owns the daily aggregated burn-down per (did, date,
--                       service); also pre-existing, no schema change needed.
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
-- passthrough (Gemini/xAI/OpenAI/Moonshot) is a raw byte passthrough by
-- design (#1925's adapter header), so a provider that omits `usage` from its
-- response/stream (despite `stream_options.include_usage` being requested)
-- still gets a usage row for call-count/session/turn/agent attribution — just
-- without token/cost figures. A degraded row beats a missing one.

CREATE SCHEMA IF NOT EXISTS inference;

CREATE TABLE IF NOT EXISTS inference.usage (
  id              TEXT        NOT NULL PRIMARY KEY,      -- usage_{nanoid}
  session_id      TEXT,                                   -- X-Session-Id header (OpenClaw); null when the caller sent none
  turn_id         TEXT,                                   -- X-Turn-Id header; null when the caller sent none
  principal_did   TEXT        NOT NULL,                   -- owner DID whose sealed connector card supplied the credential (brain.ts credentialDid)
  agent_did       TEXT,                                   -- invoking app DID (onBehalfOf); null when the owner called directly
  provider        TEXT        NOT NULL,                   -- BRAIN_CONNECTORS id, e.g. 'xai' | 'anthropic' | 'gemini' | 'openai' | 'moonshot'
  connector_id    TEXT,                                   -- kernel.connectors.id this call resolved credentials from (0114); null if the row could not be resolved
  model           TEXT        NOT NULL,
  tokens_in       INTEGER,                                -- null when the upstream response never reported usage
  tokens_out      INTEGER,
  cost_usd        NUMERIC(20, 8),                         -- null when tokens are unknown or the model has no pricing entry
  transaction_id  TEXT,                                   -- pay.transactions.id this call's spend was recorded under; null when cost is unknown
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dashboard burn-down: a principal's own spend, newest first.
CREATE INDEX IF NOT EXISTS idx_inference_usage_principal
  ON inference.usage (principal_did, created_at);

-- Burn-down by agent (delegated caller), when one is present.
CREATE INDEX IF NOT EXISTS idx_inference_usage_agent
  ON inference.usage (agent_did, created_at)
  WHERE agent_did IS NOT NULL;

-- Burn-down by session / turn (OpenClaw-supplied correlation ids).
CREATE INDEX IF NOT EXISTS idx_inference_usage_session
  ON inference.usage (session_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inference_usage_turn
  ON inference.usage (turn_id)
  WHERE turn_id IS NOT NULL;

-- Spend-cap enforcement: sum cost for one connector registry row within a
-- window, keyed exactly the way the kernel-side cap check queries it.
CREATE INDEX IF NOT EXISTS idx_inference_usage_connector
  ON inference.usage (connector_id, created_at)
  WHERE connector_id IS NOT NULL;

-- Operator read: overall volume over time.
CREATE INDEX IF NOT EXISTS idx_inference_usage_created
  ON inference.usage (created_at);
