-- Migration: 0157_loops_rail
-- owner: kernel
-- #2295 (child 1 of epic #2288/#2290) — kernel loop registry: signed
-- `loop.started | loop.progress | loop.blocked | loop.finished` bus events,
-- persisted as a queryable per-principal projection with lineage.
--
-- kernel.loop_events holds the immutable per-transition history (one row
-- per loop.* event actually ingested) — `GET /api/loops/:loopId`'s event
-- history reads this table.
--
-- kernel.loops holds the current-state-per-loopId projection, upserted by
-- the `loop-projection` bus reactor (packages/bus/src/reactors/loop-projection.ts)
-- so a reader never has to window-function over the event log to find
-- "now". `parent_loop_id` is the lineage column the ancestor query
-- (recursive CTE in GET /api/loops?ancestor=) walks.
--
-- Mirrors the operator-approvals precedent (#2059/migration 0130): a
-- dedicated state table separate from the transport (the bus event rails
-- below), signed at ingest against the publisher's own DID.

CREATE TABLE IF NOT EXISTS kernel.loop_events (
  id          text        PRIMARY KEY,
  loop_id     text        NOT NULL,
  type        text        NOT NULL,             -- loop.started | loop.progress | loop.blocked | loop.finished
  issuer      text        NOT NULL,             -- publishing agent's DID (verified signer at ingest)
  principal   text        NOT NULL,             -- onBehalfOf DID the loop is scoped to
  payload     jsonb       NOT NULL,             -- full envelope as published
  occurred_at timestamptz NOT NULL,             -- envelope's own `at`
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loop_events_loop_id
  ON kernel.loop_events (loop_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_loop_events_principal
  ON kernel.loop_events (principal, occurred_at);

CREATE TABLE IF NOT EXISTS kernel.loops (
  loop_id         text        PRIMARY KEY,
  kind            text        NOT NULL,          -- e.g. 'warp.run' | 'openclaw.subagent' | 'review' | 'pr' (open vocabulary)
  principal       text        NOT NULL,          -- onBehalfOf DID — the GET /api/loops authz boundary
  parent_loop_id  text,                          -- lineage — no FK: a parent's own loop.started may arrive after a child's
  refs            jsonb       NOT NULL DEFAULT '{}',  -- { issue?, pr?, runId?, sessionKey? }
  state           text        NOT NULL,
  summary         text        NOT NULL,
  last_event_type text        NOT NULL,
  started_at      timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loops_principal
  ON kernel.loops (principal, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_loops_parent
  ON kernel.loops (parent_loop_id)
  WHERE parent_loop_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_loops_kind
  ON kernel.loops (kind);

CREATE INDEX IF NOT EXISTS idx_loops_state
  ON kernel.loops (state);

-- loop.* lifecycle chain: `loop-projection` (awaited — materializes the two
-- tables above before publish() returns, so POST /api/loops's own write is
-- immediately readable) + `emit` (puts every transition on
-- registry.system_events too, queryable by did/correlationId alongside
-- every other bus event). Kept in sync with packages/bus/src/config.ts's
-- DEFAULTS fallback — this DB row REPLACES that list at runtime, same
-- "DB row replaces this list" convention as the warp.run.* seeds above.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES
  ('loop.started', NULL, '[{"type":"loop-projection","config":{},"await":true,"enabled":true},{"type":"emit","config":{},"enabled":true}]'::jsonb, true),
  ('loop.progress', NULL, '[{"type":"loop-projection","config":{},"await":true,"enabled":true},{"type":"emit","config":{},"enabled":true}]'::jsonb, true),
  ('loop.blocked', NULL, '[{"type":"loop-projection","config":{},"await":true,"enabled":true},{"type":"emit","config":{},"enabled":true}]'::jsonb, true),
  ('loop.finished', NULL, '[{"type":"loop-projection","config":{},"await":true,"enabled":true},{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
