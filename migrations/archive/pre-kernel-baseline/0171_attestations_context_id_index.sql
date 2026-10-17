-- 0171_attestations_context_id_index.sql
-- owner: kernel
-- #2396 (refs #1985) — `GET /auth/api/attestations?context_id=...` lets a
-- caller who already knows the exact context (e.g. a survey's asset id) fetch
-- the attestations for that context directly instead of paginating through all
-- of a subject's attestations. Back the new equality filter with an index so it
-- is never a scan.
--
-- Partial on `context_id IS NOT NULL`: most attestations carry no context, and
-- an equality predicate on a non-null value can only match indexed rows, so
-- the NULL rows would just be dead weight (same shape as
-- idx_auth_attestations_prev_event_ref / _supersedes).
--
-- Guard: IF NOT EXISTS makes this idempotent — safe to re-run, and a no-op on
-- any database where the index was already created out-of-band.

CREATE INDEX IF NOT EXISTS idx_auth_attestations_context_id
  ON auth.attestations (context_id)
  WHERE context_id IS NOT NULL;
