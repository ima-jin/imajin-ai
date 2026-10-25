-- owner: kernel
-- Operation-only SSH authority on the existing vault grant lifecycle.
ALTER TABLE kernel.vault_delegation_grants
  ADD COLUMN IF NOT EXISTS ssh_scope jsonb;

-- A collision must refuse issuance, never produce a duplicate serial.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ssh_cert_serial
  ON auth.attestations ((payload->>'serial'))
  WHERE type = 'vault.ssh-cert.issued';
