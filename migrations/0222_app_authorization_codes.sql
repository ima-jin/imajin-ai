-- owner: kernel
-- App sign-in codes are hashed at rest and retained after atomic consumption.
CREATE TABLE IF NOT EXISTS auth.app_authorization_codes (
  code_hash text PRIMARY KEY,
  app_did text NOT NULL,
  subject_did text NOT NULL,
  attestation_id text NOT NULL,
  callback_url text NOT NULL,
  state text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
