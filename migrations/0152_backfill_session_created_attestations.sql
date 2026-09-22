-- 0152_backfill_session_created_attestations.sql
-- owner: kernel
--
-- #1825: bulk-clean the stale pending `session.created` attestations that
-- accumulated before #1822 shipped (PR #1828, merged 2026-08-12T16:53:23Z).
--
-- Root cause (#1822): `emitSessionAttestation()` inserted the mechanical
-- `session.created` row without ever setting `attestation_status`, so it
-- silently took the column's `'pending'` default -- the same status the
-- bilateral author_jws/witness_jws countersign flow uses for "genuinely
-- awaiting the subject's signature." That surfaced ~1,052 purely mechanical
-- audit records (minted by the kernel node identity on every prod session
-- start since 2026-04-11) as "pending your countersignature."
--
-- The fix (apps/kernel/src/lib/auth/emit-mechanical-attestation.ts, shared
-- by emitSessionAttestation) now explicitly inserts new `session.created`
-- rows with `attestation_status = NULL` -- the existing "not a
-- countersignable attestation" convention already used elsewhere (see
-- POST /auth/api/attestations: `attestationStatus: authorJws ? 'pending' : null`).
-- NULL, not a terminal string value like 'confirmed'/'executed', is the
-- correct target state for these rows because it's exactly what the fixed
-- code path itself writes for every new session.created row -- backfilling
-- to anything else would leave old and new mechanical rows in
-- inconsistent, distinguishable states.
--
-- This migration transitions only the stale rows the fix could not reach
-- retroactively: `type = 'session.created'`, still `attestation_status =
-- 'pending'`, and `issued_at` strictly before the #1822 fix's merge
-- instant. Rows created at/after that instant already get `NULL` from the
-- fixed insert path and are left untouched, as is every other attestation
-- type. Additionally scoped to the kernel node identity's own DID (the
-- only issuer `emitSessionAttestation` ever mints as, per the issue) as a
-- second, redundant safety rail.
--
-- Idempotent: the `attestation_status = 'pending'` predicate means a
-- second run matches zero rows once applied. Re-running is a safe no-op.
DO $$
DECLARE
  affected_count integer;
BEGIN
  UPDATE auth.attestations
  SET attestation_status = NULL
  WHERE type = 'session.created'
    AND attestation_status = 'pending'
    AND issuer_did = 'did:imajin:6Y6fwZeqe1wME3heZ2vy1cV3x9zwq4Gphqm6yKC95dBg'
    AND issued_at < '2026-08-12T16:53:23Z'::timestamptz;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE '#1825 backfill: % stale pending session.created attestation(s) transitioned to NULL', affected_count;
END $$;
