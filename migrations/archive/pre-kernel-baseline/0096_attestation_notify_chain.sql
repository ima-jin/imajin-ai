-- 0096_attestation_notify_chain.sql
-- Seed the `attestation-notify` reactor into the `attestation.created` chain
-- so the notify button actually sends an email (Issue #1856).
--
-- Problem: migration 0039 seeded `attestation.created` with only `emit`.
-- #1820/#1821 (commit b71b8d2) added `attestation-notify` to the
-- packages/bus/src/config.ts DEFAULTS entry for `attestation.created`, but
-- shipped no migration to update the existing DB row. getChainConfig() reads
-- the DB row first and only falls back to DEFAULTS when no row exists
-- (packages/bus/src/config.ts), so in any environment that ran 0039 the
-- `attestation-notify` reactor never fires — the DB row silently shadows the
-- code-level default.
--
-- Fix: update the existing (event_type='attestation.created', scope IS NULL)
-- row so its reactor chain matches DEFAULTS: emit + attestation-notify.
--
-- Follows 0084/0091: scope = NULL (node default), idempotent
-- `ON CONFLICT ... DO UPDATE` so this is safe to re-run and also covers a
-- clean bootstrap where 0039 never ran.
--
-- Depends on:
--   #763  / migration 0039 — attestation.created seeded with emit only
--   #1820 / #1821          — attestation-notify added to DEFAULTS (code)
--   #1856                  — this migration (DB catch-up)

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'attestation.created',
  NULL,
  '[{"type":"emit","config":{},"enabled":true},{"type":"attestation-notify","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
