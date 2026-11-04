-- owner: kernel
-- Send-only Postal state. Credential material is never stored here.
CREATE TABLE IF NOT EXISTS kernel.mail_domains (
  owner_did text NOT NULL,
  domain text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  ownership_verified boolean NOT NULL DEFAULT false,
  dns_ok boolean NOT NULL DEFAULT false,
  records jsonb NOT NULL DEFAULT '[]'::jsonb,
  postal_id text,
  operation_id text,
  binding_attestation_id text NOT NULL,
  checked_at timestamptz,
  next_check_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_did, domain),
  CONSTRAINT mail_domains_state_check CHECK (state IN ('pending', 'verified', 'disabled')),
  CONSTRAINT mail_domains_ready_check CHECK (state <> 'verified' OR (ownership_verified AND dns_ok))
);
CREATE INDEX IF NOT EXISTS idx_mail_domains_pending ON kernel.mail_domains(next_check_at)
  WHERE state = 'pending';
