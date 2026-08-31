-- 0106_intro_attribution.sql
-- Intro-attribution .fair template (#1886) — the matchmaking-specific
-- template that rides the existing .fair cascade (#509), joining #1885's
-- attestation chain to a .fair manifest's provenance[].
--
-- Two things settled at the #1886 Day-1 review (2026-08-30, carried from
-- the #1881 RFC review):
--
--   1. `value_realized` is the off-platform trigger fact — one party
--      claims value was realized outside the platform, the other
--      countersigns via the EXISTING bilateral countersign/decline flow
--      (auth.attestations.attestation_status). Seeded here into
--      auth.attestation_type_registry (#1885's registry-as-data),
--      mirroring migration 0100's platform-seed pattern exactly. Also
--      present in packages/auth/src/types/attestation.ts's ATTESTATION_TYPES
--      for zero-DB-hit TS-level validation, same convention as the five
--      intro-funnel types.
--
--   2. The 70/15/15 split and the attribution window are the matchmaking
--      agent's OFFER, declared at knock time (#1883's advisory
--      requested_capabilities preview) and CONSENTED at grant time (#1882)
--      — not a platform-imposed constant. auth.intro_attribution_terms is
--      a side table keyed 1:1 on auth.delegation_grants(id): it composes
--      with #1882 rather than adding columns to delegation_grants itself,
--      so the core grant lifecycle (issue/revoke/renew/introspect) stays
--      untouched. knock_id is optional provenance back to the originating
--      #1883 knock, when the grant followed one.
--
-- Attribution survives grant expiry (expiry severs authority, not
-- attribution, per #1886 invariant 8) — attribution_window_days is what
-- bounds it, not delegation_grants.expires_at. This table is therefore
-- read by its grant_id even after the grant itself has expired or been
-- revoked; nothing here cascades attribution loss from grant lifecycle
-- changes.

INSERT INTO auth.attestation_type_registry (type_name, namespace, registered_by_did, description)
VALUES
  ('value_realized', 'platform', NULL, 'One party claims off-platform value was realized (a deal closed, a hire made); the other countersigns. Only the countersigned (bilateral) form may trigger a .fair settlement (#1886).')
ON CONFLICT (type_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS auth.intro_attribution_terms (
  id                        TEXT        NOT NULL PRIMARY KEY,             -- iat_{nanoid}
  grant_id                  TEXT        NOT NULL UNIQUE REFERENCES auth.delegation_grants(id) ON DELETE CASCADE,
  knock_id                  TEXT        REFERENCES auth.agent_knocks(id), -- originating #1883 knock, if any
  delegator_did             TEXT        NOT NULL,                         -- the consenting principal (== the grant's delegator)
  matchmaker_did            TEXT        NOT NULL,                         -- the agent's own DID (== the grant's agent_did)
  matchmaker_share_bps      INTEGER     NOT NULL DEFAULT 7000,
  party_a_share_bps         INTEGER     NOT NULL DEFAULT 1500,
  party_b_share_bps         INTEGER     NOT NULL DEFAULT 1500,
  attribution_window_days   INTEGER     NOT NULL DEFAULT 365,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_intro_attribution_terms_split_sum
    CHECK (matchmaker_share_bps + party_a_share_bps + party_b_share_bps = 10000),
  CONSTRAINT chk_intro_attribution_terms_window_positive
    CHECK (attribution_window_days > 0)
);

-- Settlement-time join surface: "does this grant have consented terms?"
CREATE INDEX IF NOT EXISTS idx_intro_attribution_terms_grant
  ON auth.intro_attribution_terms (grant_id);

-- Delegator-side listing (e.g. a grants-view detail panel showing declared terms).
CREATE INDEX IF NOT EXISTS idx_intro_attribution_terms_delegator
  ON auth.intro_attribution_terms (delegator_did);
