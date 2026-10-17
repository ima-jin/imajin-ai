-- 0060_identity_aliases.sql
-- Partner-scoped natural-key lookup for lazy get-or-create identity minting
-- (Issue #1230).
--
-- Backs POST /registry/identity: partners (e.g. Tripian) reference entities by
-- their own external ids, and each (namespace, ref) pair maps to a single
-- canonical did:imajin: DID. The UNIQUE (namespace, ref) constraint is what
-- makes concurrent first-references collapse to one minted DID
-- (INSERT ... ON CONFLICT DO NOTHING).
--
-- The partner namespace is metadata, not a new DID method: `did` is always a
-- did:imajin: identifier.

CREATE TABLE IF NOT EXISTS kernel.identity_aliases (
  namespace   TEXT NOT NULL,       -- partner namespace, e.g. 'tripian'
  ref         TEXT NOT NULL,       -- partner-scoped external id, e.g. 'restaurant:kai-honolulu'
  did         TEXT NOT NULL,       -- canonical did:imajin: DID this ref resolves to
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_aliases_namespace_ref
  ON kernel.identity_aliases (namespace, ref);

CREATE INDEX IF NOT EXISTS idx_identity_aliases_did
  ON kernel.identity_aliases (did);
