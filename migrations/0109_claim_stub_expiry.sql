-- 0109_claim_stub_expiry.sql
-- Unclaimed-stub expiry policy (#1841, ratified proposal comment on #1841,
-- 2026-08-31: "Proposed policy: unclaimed-stub expiry, tombstone,
-- re-introduction, and `lapsed` attestations"). Builds on the claimable-stub
-- primitive from #1834 Phase 1 (migration 0093).
--
-- auth.claim_stub_index: move off a bare-HMAC primary key so an expired
-- row's key can be reused by a fresh mint (design consideration 3 —
-- re-introduction after expiry mints a NEW stub rather than resurrecting
-- the tombstoned one).
ALTER TABLE auth.claim_stub_index ADD COLUMN id text;
UPDATE auth.claim_stub_index SET id = 'cstub_' || email_hmac WHERE id IS NULL;
ALTER TABLE auth.claim_stub_index ALTER COLUMN id SET NOT NULL;
ALTER TABLE auth.claim_stub_index DROP CONSTRAINT claim_stub_index_pkey;
ALTER TABLE auth.claim_stub_index ADD PRIMARY KEY (id);

-- 'active' | 'expired'. Tombstone, never delete (design consideration 2):
-- the row is retained with both email_hmac and email_encrypted intact so a
-- later re-introduction of the same email can recognize "there was already
-- a stub here" without resurrecting the lapsed claim window.
ALTER TABLE auth.claim_stub_index
  ADD COLUMN stub_status     text NOT NULL DEFAULT 'active',
  ADD COLUMN stub_expires_at timestamptz,
  ADD COLUMN expired_at      timestamptz;

-- Standard "unique among live rows only" pattern: lets
-- mintOrAccrueClaimableStub insert a fresh row keyed by the same email_hmac
-- once the old one is 'expired', without ever rewriting the historical key.
CREATE UNIQUE INDEX uniq_claim_stub_index_active_email
  ON auth.claim_stub_index (email_hmac) WHERE stub_status = 'active';

-- Backs the expiry sweep's scan for active stubs past their TTL.
CREATE INDEX idx_claim_stub_index_expiry
  ON auth.claim_stub_index (stub_expires_at) WHERE stub_status = 'active';

-- auth.attestations / connections.invites: observability timestamps for the
-- new terminal 'lapsed' state (design consideration 4). Both status columns
-- are already free text with no DB CHECK constraint, so no ALTER TYPE is
-- needed for the 'lapsed' value itself.
ALTER TABLE auth.attestations ADD COLUMN lapsed_at timestamptz;
ALTER TABLE connections.invites ADD COLUMN lapsed_at timestamptz;
