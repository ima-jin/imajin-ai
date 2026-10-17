-- 0103_event_subscription_log.sql
-- Grant-bound event-subscription surface for external agents (#1884), built
-- on #1882's delegation grants (auth.delegation_grants) and the eventTypes
-- entitlement already declared per scope in packages/auth/src/grant-scopes.ts.
--
-- Settled design (#1881 Day-1 review, 2026-08-30):
--   - Delivery is WebSocket v1, over the same channel agents already
--     authenticate on via challenge-response (#1883) — see the existing
--     `did-push` fan-out in apps/kernel/ws-server.js. This table is NOT the
--     delivery channel; it is the durable log cursor catch-up reads from.
--     No apps/kernel/ws-server.js changes were needed: packages/bus's new
--     event-subscription fan-out (packages/bus/src/subscriptions.ts) calls
--     the existing internal did-push route directly.
--   - Subscription = derived from active grants, not a stored ACL. There is
--     deliberately no `event_subscriptions` table: an agent's current
--     entitlement is recomputed from auth.delegation_grants +
--     auth.delegation_grant_capabilities on every read (live push AND
--     catch-up), so a revoked grant stops delivery at the very next check —
--     including buffered/missed events, not just new ones (fail-closed on
--     the event plane, same invariant as #1882's introspection on the
--     action plane).
--   - One row per published event whose type ANY grant scope could entitle
--     (see eventTypesForGrantScopes in packages/auth). Written
--     unconditionally from packages/bus/src/publish.ts — independent of any
--     bus_chain_configs wiring, since not every entitleable event type has a
--     configured reactor chain today. Recipients are never denormalized onto
--     the row; they are resolved at read time against current grants, so a
--     *newly issued* grant can catch up on events published before it
--     existed (within the retention window), and a revoked grant sees
--     nothing further.
--   - `seq` is the monotonic cursor a reconnecting agent presents
--     (`GET /auth/api/events/subscriptions/catchup?cursor=<seq>`); `id` is
--     the stable per-event dedupe/idempotency key delivered in both the live
--     WS push frame and the catch-up response.
--   - Retention is a modest window (EVENT_SUBSCRIPTION_RETENTION in
--     packages/auth/src/constants.ts, 14 days), not infinite replay — see
--     GET /api/cron/event-subscription-cleanup for the sweep.
--
-- Raw SQL (not Drizzle push) because packages/bus writes to this table and
-- packages/bus must never import apps/kernel's Drizzle schema (see
-- packages/bus/AGENTS.md). apps/kernel mirrors this shape in
-- src/db/schemas/bus.ts (kernel.event_subscription_log) for read-side
-- (catch-up route) and cleanup-cron use via Drizzle.

CREATE TABLE IF NOT EXISTS kernel.event_subscription_log (
  id              TEXT        NOT NULL PRIMARY KEY,          -- stable dedupe/idempotency key
  seq             BIGSERIAL   NOT NULL,                       -- monotonic cursor
  event_type      TEXT        NOT NULL,
  issuer_did      TEXT        NOT NULL,
  subject_did     TEXT        NOT NULL,
  scope           TEXT        NOT NULL,
  payload         JSONB,
  correlation_id  TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cursor catch-up hot path: WHERE seq > ? ORDER BY seq.
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_subscription_log_seq
  ON kernel.event_subscription_log (seq);

-- Cursor catch-up with the entitled-event-type filter applied:
-- WHERE event_type = ANY(...) AND seq > ? ORDER BY seq.
CREATE INDEX IF NOT EXISTS idx_event_subscription_log_type_seq
  ON kernel.event_subscription_log (event_type, seq);

-- Retention sweep (GET /api/cron/event-subscription-cleanup).
CREATE INDEX IF NOT EXISTS idx_event_subscription_log_created_at
  ON kernel.event_subscription_log (created_at);
