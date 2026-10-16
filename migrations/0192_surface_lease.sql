-- Migration: 0192_surface_lease
-- owner: kernel
-- #2405: advisory holdings, not locks or dispatch gates. Expired rows are free.
CREATE TABLE IF NOT EXISTS kernel.surface_lease (
  surface text PRIMARY KEY,
  loop_id text NOT NULL,
  principal text NOT NULL,
  issuer text NOT NULL,
  signature jsonb NOT NULL,
  signed_payload jsonb NOT NULL,
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  released_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_surface_lease_principal
  ON kernel.surface_lease (principal, expires_at);
CREATE INDEX IF NOT EXISTS idx_surface_lease_loop
  ON kernel.surface_lease (loop_id, principal, issuer);

-- Projection is transactional inside the authenticated kernel ingest boundary.
-- Only emit here: a surface observation must never rewrite kernel.loops state.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES
  ('surface.acquired', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true),
  ('surface.released', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true),
  ('surface.conflicted', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors, updated_at = now();
