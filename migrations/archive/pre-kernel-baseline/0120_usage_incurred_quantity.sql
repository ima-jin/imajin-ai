-- 0120_usage_incurred_quantity.sql
-- The `usage.incurred` primitive (#1148, remaining scope after #1923 / PR
-- #1946 landed the table + `source`/`resource` discriminators in migration
-- 0119). This migration adds the two columns #1147's emitter-agnostic event
-- shape requires (`quantity` / `unit`) and seeds the bus chain configs that
-- turn a written row into a signed system-class fact.
--
-- Reserved numbering note: 0121/0122 belong to #1151 (emitter registry +
-- external adapters) and #1076 (provider-billed reconciliation), running in
-- parallel — do not reuse.
--
-- `quantity`/`unit` are nullable: every pre-existing row (and any emitter
-- that has not wired them yet) has neither, same "a degraded row beats a
-- missing one" rationale 0119 already established for tokens_in/tokens_out.
-- The inference-passthrough emitter (usage-ledger.ts) writes
-- `quantity = tokens_in + tokens_out`, `unit = 'tokens'` whenever both token
-- counts are known.
ALTER TABLE usage.incurred ADD COLUMN IF NOT EXISTS quantity NUMERIC(24, 6);
ALTER TABLE usage.incurred ADD COLUMN IF NOT EXISTS unit TEXT;

-- Chain config (#1147's "bread is free" pattern): usage.incurred rows get an
-- `attestation` (the durable signed record on the emitting agent's own DID)
-- and an `emit` (puts it on the live event stream), and deliberately NO
-- `settle` reactor — recording cost is not charging for it. Scope = NULL
-- (node default), matching every other seeded row in this table. Kept in
-- sync with packages/bus/src/config.ts's DEFAULTS map.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'usage.incurred',
  NULL,
  '[{"type":"attestation","config":{"attestationType":"usage.incurred"},"enabled":true},{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();

-- Same chain, for the daily clock-rollup's own `usage.rollup` attestation
-- (one signed record per (principal, window) — see
-- apps/kernel/src/lib/usage/rollup.ts). The rollup's `attestation` step runs
-- `await: true` (unlike the per-call emitter above, which must never add
-- request latency): this is an offline cron path, so awaiting the signed
-- write lets the sweep report accurate published/skipped counts. Still NO
-- `settle` reactor — a rollup summarizes metered usage, it never bills it.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'usage.rollup',
  NULL,
  '[{"type":"attestation","config":{"attestationType":"usage.rollup"},"enabled":true,"await":true},{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
