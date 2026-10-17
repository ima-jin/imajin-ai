-- 0198_foreign_agent_stubs.sql
-- owner: kernel
-- #2590: auto-minted, reach-only requester stubs. Never full agent identities.
-- Revocation is a durable tombstone: repeat contact cannot remint a blocked sender.
CREATE TABLE IF NOT EXISTS auth.foreign_agent_stubs (
  stub_did TEXT PRIMARY KEY REFERENCES auth.identities(id),
  requester_did TEXT NOT NULL,
  signer_key TEXT NOT NULL,
  requester_aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  signer_aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  principal_did TEXT NOT NULL REFERENCES auth.identities(id),
  capability TEXT NOT NULL DEFAULT 'reach' CHECK (capability = 'reach'),
  revoked_at TIMESTAMPTZ,
  promoted_to TEXT REFERENCES auth.identities(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_foreign_agent_stubs_requester_principal
  ON auth.foreign_agent_stubs (requester_did, principal_did);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_foreign_agent_stubs_signer_principal
  ON auth.foreign_agent_stubs (signer_key, principal_did);
