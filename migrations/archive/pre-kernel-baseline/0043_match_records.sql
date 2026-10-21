-- 0043_match_records.sql
-- Bilateral match engine — spent-forever tracking + chain config seeds (Issue #1102)

-- ---------------------------------------------------------------------------
-- bus.match_records — one record per matched intent PAIR, ever
-- ---------------------------------------------------------------------------
-- UNIQUE(intent_a, intent_b) is the spent-enforcement mechanism.
-- The engine attempts INSERT; on conflict the pair is already spent → skip.
-- intent_a / intent_b are canonically ordered (lesser id first) so the pair
-- is commutative: (A,B) and (B,A) both hit the same UNIQUE row.

CREATE TABLE IF NOT EXISTS kernel.match_records (
  id           TEXT PRIMARY KEY,
  intent_a     TEXT NOT NULL,       -- lesser of the two intent ids (canonical order)
  intent_b     TEXT NOT NULL,       -- greater of the two intent ids (canonical order)
  overlap_tags TEXT[] NOT NULL,
  sensitive    BOOLEAN NOT NULL DEFAULT false,
  matched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (intent_a, intent_b)
);

CREATE INDEX IF NOT EXISTS idx_match_records_intent_a ON kernel.match_records (intent_a);
CREATE INDEX IF NOT EXISTS idx_match_records_intent_b ON kernel.match_records (intent_b);

-- ---------------------------------------------------------------------------
-- Chain config seeds
-- ---------------------------------------------------------------------------

-- availability.intent.created: trigger the match engine on every new intent.
-- The match-engine reactor is registered in packages/bus/src/index.ts.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'availability.intent.created',
  NULL,
  '[{"type":"match-engine","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO NOTHING;

-- availability.match: broker pipeline chain for the match engine's disclosure call.
-- mutual-reach-consent replaces named-grantee consent (validates mutual reach rings).
-- intersection-scope replaces flat-field scope (computes tag set-AND + OR-sensitivity).
-- release + audit are the existing reactors reused unchanged.
-- Registered in packages/bus/src/broker.ts via registerBrokerReactor().
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'availability.match',
  NULL,
  '[{"type":"mutual-reach-consent","config":{},"enabled":true},{"type":"intersection-scope","config":{},"enabled":true},{"type":"release","config":{},"enabled":true},{"type":"audit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO NOTHING;

-- availability.match.surfaced: emitted by the engine after a successful disclosure.
-- Consumed by the broker agent (#1101) for chat rendering. Emit-only for now.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'availability.match.surfaced',
  NULL,
  '[{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO NOTHING;
