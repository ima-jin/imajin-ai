-- 0170_emission_config.sql
-- owner: kernel
--
-- #2017 (sub-issue of #738): emission amounts become configuration.
--
-- 1. `kernel.bus_chain_configs.version` -- a monotonic per-row version, bumped
--    by trigger whenever `reactors` or `enabled` changes (so an operator's
--    plain UPDATE is versioned too). Every emission records the (row id,
--    version) that produced it.
-- 2. `pay.transactions` gains first-class provenance + idempotency columns:
--    `emission_config_id` / `emission_config_version` (which config row
--    version minted this emission; `attestation_id` already exists from
--    #2016) and `idempotency_key` with a partial UNIQUE index, so the bus's
--    retrying `mjn` reactor can never double-credit.
-- 3. The emission schedule moves out of packages/bus/src/emissions.ts into
--    the `mjn` reactor entry of each chain row's `config.emit[]`
--    (recipient -> amount | percent). Missing node-default rows are inserted;
--    existing rows (any scope) get the schedule merged into their `mjn`
--    entry, plus `await: true`. Rows whose `mjn` entry already has an `emit`
--    key are left untouched, so a node's customised schedule survives a
--    re-run. Values mirror the pre-#2017 hard-coded schedule exactly. The
--    old `gas` declaration is dropped (it was never debited).
--
-- Seed data is written BEFORE the version trigger exists so the seeded rows
-- start at version 1.

ALTER TABLE kernel.bus_chain_configs
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE pay.transactions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS emission_config_id TEXT,
  ADD COLUMN IF NOT EXISTS emission_config_version INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_transactions_idempotency_key
  ON pay.transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Node-default chain rows that do not exist yet (fresh DBs, or types that only
-- ever ran from the code DEFAULTS). The `mjn` entry is completed by the UPDATE below.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
SELECT b.event_type, NULL, b.reactors, true
FROM (VALUES
  ('identity.created', '[{"type":"attestation","config":{"attestationType":"identity.created"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"identity.created"},"await":true,"enabled":true},{"type":"emit","config":{},"enabled":true}]'::jsonb),
  ('identity.verified.preliminary', '[{"type":"attestation","config":{"attestationType":"identity.verified.preliminary"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"identity.verified.preliminary"},"await":true,"enabled":true}]'::jsonb),
  ('identity.verified.hard', '[{"type":"attestation","config":{"attestationType":"identity.verified.hard"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"identity.verified.hard"},"await":true,"enabled":true}]'::jsonb),
  ('connection.accepted', '[{"type":"attestation","config":{"attestationType":"connection.accepted"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"connection.accepted"},"await":true,"enabled":true},{"type":"notify","config":{"template":"invite_accepted"},"enabled":true}]'::jsonb),
  ('vouch', '[{"type":"attestation","config":{"attestationType":"vouch"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"vouch"},"await":true,"enabled":true}]'::jsonb),
  ('ticket.purchased', '[{"type":"attestation","config":{"attestationType":"ticket.purchased"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"ticket.purchased"},"await":true,"enabled":true},{"type":"notify","config":{"scope":"event:ticket"},"enabled":true}]'::jsonb),
  ('listing.purchased', '[{"type":"attestation","config":{"attestationType":"listing.purchased"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"listing.purchased"},"await":true,"enabled":true},{"type":"settle","config":{},"await":true,"enabled":true},{"type":"notify","config":{"scope":"market:purchase"},"enabled":true}]'::jsonb),
  ('tip.granted', '[{"type":"attestation","config":{"attestationType":"tip.granted"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"tip.granted"},"await":true,"enabled":true},{"type":"notify","config":{"scope":"coffee:tip"},"enabled":true}]'::jsonb),
  ('event.attendance', '[{"type":"attestation","config":{"attestationType":"event.attendance"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"event.attendance"},"await":true,"enabled":true}]'::jsonb),
  ('event.created', '[{"type":"attestation","config":{"attestationType":"event.created"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"event.created"},"await":true,"enabled":true}]'::jsonb),
  ('handle.claimed', '[{"type":"attestation","config":{"attestationType":"handle.claimed"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"handle.claimed"},"await":true,"enabled":true}]'::jsonb),
  ('group.created', '[{"type":"attestation","config":{"attestationType":"group.created"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"group.created"},"await":true,"enabled":true}]'::jsonb),
  ('scope.onboard', '[{"type":"attestation","config":{"attestationType":"scope.onboard"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"scope.onboard"},"await":true,"enabled":true}]'::jsonb)
) AS b(event_type, reactors)
ON CONFLICT ON CONSTRAINT uniq_bus_chain_configs_event_type_scope DO NOTHING;

-- Merge the schedule into every `mjn` entry that has none yet.
UPDATE kernel.bus_chain_configs c
SET reactors = (
  SELECT jsonb_agg(
    CASE
      WHEN r.elem->>'type' = 'mjn' AND (r.elem->'config'->'emit') IS NULL
        THEN jsonb_set(
               r.elem,
               '{config}',
               (r.elem->'config') || jsonb_build_object('unit', 'MJNx', 'emit', s.emit)
             ) || '{"await":true}'::jsonb
      ELSE r.elem
    END
    ORDER BY r.ord
  )
  FROM jsonb_array_elements(c.reactors) WITH ORDINALITY AS r(elem, ord)
)
FROM (VALUES
  ('identity.created', '[{"to":"subject","amount":10,"reason":"Welcome to the network"}]'::jsonb),
  ('identity.verified.preliminary', '[{"to":"subject","amount":100,"reason":"Preliminary verification"}]'::jsonb),
  ('identity.verified.hard', '[{"to":"subject","amount":100,"reason":"Full identity verified"}]'::jsonb),
  ('connection.accepted', '[{"to":"subject","amount":1,"reason":"Connection accepted"},{"to":"issuer","amount":1,"reason":"Connection accepted"}]'::jsonb),
  ('vouch', '[{"to":"subject","amount":2,"reason":"Vouched for"}]'::jsonb),
  ('ticket.purchased', '[{"to":"subject","percent":0.25,"reason":"Ticket purchase reward"},{"to":"issuer","percent":0.25,"reason":"Ticket sale reward"}]'::jsonb),
  ('listing.purchased', '[{"to":"subject","percent":0.25,"reason":"Purchase reward"},{"to":"issuer","percent":0.25,"reason":"Sale reward"}]'::jsonb),
  ('tip.granted', '[{"to":"issuer","amount":1,"reason":"Generosity reward"},{"to":"subject","percent":0.5,"reason":"Tip received"}]'::jsonb),
  ('event.attendance', '[{"to":"subject","amount":0.002,"reason":"Event attended"}]'::jsonb),
  ('event.created', '[{"to":"issuer","amount":5,"reason":"Event created"}]'::jsonb),
  ('handle.claimed', '[{"to":"subject","amount":2,"reason":"Handle claimed"}]'::jsonb),
  ('group.created', '[{"to":"issuer","amount":10,"reason":"Forest created"}]'::jsonb),
  ('scope.onboard', '[{"to":"subject","amount":5,"reason":"Joined community"},{"to":"scope","amount":1,"reason":"New member onboarded"}]'::jsonb)
) AS s(event_type, emit)
WHERE c.event_type = s.event_type
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(c.reactors) AS e
    WHERE e->>'type' = 'mjn' AND (e->'config'->'emit') IS NULL
  );

CREATE OR REPLACE FUNCTION kernel.bus_chain_configs_bump_version()
RETURNS trigger AS $$
BEGIN
  IF NEW.reactors IS DISTINCT FROM OLD.reactors OR NEW.enabled IS DISTINCT FROM OLD.enabled THEN
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bus_chain_configs_bump_version ON kernel.bus_chain_configs;
CREATE TRIGGER trg_bus_chain_configs_bump_version
  BEFORE UPDATE ON kernel.bus_chain_configs
  FOR EACH ROW EXECUTE FUNCTION kernel.bus_chain_configs_bump_version();
