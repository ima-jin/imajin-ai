-- Operator-owned production preflight for #3023. Read-only; no token-liveness
-- filter: expired-but-unrevoked grants still participate in the unique index.
BEGIN TRANSACTION READ ONLY;
SELECT COALESCE(SUM(grant_count - 1), 0)::bigint AS surplus_count
FROM (
  SELECT issuer_did, subject_did, COUNT(*) AS grant_count
  FROM auth.attestations
  WHERE type = 'app.authorized' AND revoked_at IS NULL
  GROUP BY issuer_did, subject_did
  HAVING COUNT(*) > 1
) AS surplus;
COMMIT;
