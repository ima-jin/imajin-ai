-- owner: kernel
-- #2290: queryable signed refs and principal-scoped usage correlation.
CREATE INDEX IF NOT EXISTS idx_loops_refs ON kernel.loops USING gin (refs jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_loops_principal_run ON kernel.loops (principal, (refs->>'runId'));
CREATE INDEX IF NOT EXISTS idx_usage_incurred_principal_session
  ON usage.incurred (principal_did, session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_loop_events_principal_session
  ON kernel.loop_events (principal, (payload->'refs'->>'sessionKey'));
