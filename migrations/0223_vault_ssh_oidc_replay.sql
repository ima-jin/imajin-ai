-- owner: kernel
-- GitHub bindings live in the existing signed ssh_scope JSON, not new columns.
-- The replay projection expires at token exp; immutable issuance history stays.
CREATE INDEX IF NOT EXISTS idx_attestations_ssh_oidc_replay
  ON auth.attestations ((payload->'githubJob'->>'jtiHash'), issued_at)
  WHERE type = 'vault.ssh-cert.issued';

-- All-time refusal dedupe across node-subject and grantee-subject paths.
-- Legacy refusal rows without a jtiHash remain intact and are not dedupe keys.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attestations_ssh_oidc_refusal
  ON auth.attestations ((payload->>'jtiHash'))
  WHERE type = 'vault.ssh-cert.refused';
