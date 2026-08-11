-- 0090_backfill_app_authorization_channel_links.sql
-- Issue #1803 — backfill auth.channel_links from existing unrevoked
-- app.authorized attestations, so suppliers who already consented to an
-- app's requested scopes (e.g. supply:read) via the OAuth authorize/consent
-- screen do not need to re-consent now that the supply lot route
-- (apps/kernel/src/lib/supply.ts:handleLotGet) enforces a per-supplier
-- channel_links grant on top of the token scope check.
--
-- Shape matches what projectAppAuthorizationGrant() (introduced alongside
-- this migration, apps/kernel/src/lib/auth/app-authorization-grant.ts) writes
-- going forward on every future consent: one active row per (issuer_did,
-- subject_did) pair, channel = 'app', channel_uid = issuer_did (the granting
-- user's own DID — already unique per user, so it fits the existing
-- uniq_channel_links_pair(channel, channel_uid, app_did) index cleanly).
--
-- Idempotent: re-running always converges each (issuer, app) row to the
-- scopes on that pair's current latest unrevoked attestation.

INSERT INTO auth.channel_links (id, channel, channel_uid, did, app_did, scopes, status, created_at, revoked_at)
SELECT
  'clink_backfill_' || substr(md5(latest.issuer_did || ':' || latest.subject_did), 1, 20),
  'app',
  latest.issuer_did,
  latest.issuer_did,
  latest.subject_did,
  latest.scopes,
  'active',
  now(),
  NULL
FROM (
  -- Only the latest unrevoked app.authorized attestation per (issuer, app)
  -- pair — the authorize route's re-consent flow guarantees at most one
  -- exists at a time, but DISTINCT ON guards against any historical
  -- anomaly rather than assuming that invariant holds for every row ever
  -- written.
  SELECT DISTINCT ON (a.issuer_did, a.subject_did)
    a.issuer_did,
    a.subject_did,
    COALESCE(a.payload -> 'scopes', '[]'::jsonb) AS scopes
  FROM auth.attestations a
  WHERE a.type = 'app.authorized'
    AND a.revoked_at IS NULL
  ORDER BY a.issuer_did, a.subject_did, a.issued_at DESC, a.id DESC
) latest
WHERE jsonb_array_length(latest.scopes) > 0
ON CONFLICT (channel, channel_uid, app_did) DO UPDATE
SET scopes = EXCLUDED.scopes,
    status = 'active',
    revoked_at = NULL;
