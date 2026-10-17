-- 0151_foreign_principal_stubs.sql
-- owner: kernel
--
-- #2251: per-principal agent endpoint — a foreign agent reaches a specific
-- human's agent by DID, under a principal-authored gate, both sides signed.
--
-- Generalizes the email-keyed claimable-stub primitive (#1834,
-- auth.claim_stub_index) to a foreign agent's own principal (e.g. Alice, a
-- Meta Muse user) who discloses no PII to us at all — not even an email.
-- Keyed by a salted/peppered HMAC of `${platform}:${externalRef}` (an
-- opaque, platform-scoped reference), so repeat reach requests "acting for"
-- the same external principal resolve to the same soft-tier stub DID
-- (match-without-disclosure).
--
-- No claim ratchet in this table (unlike claim_stub_index) — the stub
-- exists purely as the `onBehalfOf` linkage target recorded on `agent.reach`
-- attestations. A claim path is explicit follow-up work, not part of this
-- slice.
--
-- ADDITIVE ONLY.

CREATE TABLE IF NOT EXISTS auth.foreign_principal_stubs (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  external_ref_hmac TEXT NOT NULL,
  stub_did TEXT NOT NULL UNIQUE REFERENCES auth.identities(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_foreign_principal_stubs_lookup
  ON auth.foreign_principal_stubs (platform, external_ref_hmac);

CREATE INDEX IF NOT EXISTS idx_foreign_principal_stubs_stub_did
  ON auth.foreign_principal_stubs (stub_did);

-- Bus event chains for the reach route's outcomes (#2251). `audit-log`
-- mirrors the vault.delegation.fetched pattern (migration 0148): every
-- reach attempt, answered or denied, lands a durable, queryable row in
-- kernel.audit_log without a new visibility primitive. Kept in sync with
-- the packages/bus/src/config.ts DEFAULTS entries.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'agent.reach.answered',
  NULL,
  '[{"type":"audit-log","config":{"fields":["requesterDid","principalDid","onBehalfOfStubDid","purpose","field","answer","grantId"]},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'agent.reach.denied',
  NULL,
  '[{"type":"audit-log","config":{"fields":["requesterDid","principalDid","reason"]},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
