-- owner: kernel
-- GitHub bindings live in the existing signed ssh_scope JSON, not new columns.
-- The replay projection expires at token exp; immutable issuance history stays.
CREATE INDEX IF NOT EXISTS idx_attestations_ssh_oidc_replay
  ON auth.attestations ((payload->'githubJob'->>'jtiHash'), issued_at)
  WHERE type = 'vault.ssh-cert.issued';
