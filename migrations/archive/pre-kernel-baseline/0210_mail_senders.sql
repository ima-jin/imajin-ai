-- owner: kernel
-- #2919: send-only owner/app sender configuration. No mailbox provisioning.
CREATE SCHEMA IF NOT EXISTS kernel;
CREATE TABLE IF NOT EXISTS kernel.mail_senders (
  owner_did text NOT NULL,
  purpose text NOT NULL,
  app_did text NOT NULL DEFAULT '',
  domain text NOT NULL,
  local_part text NOT NULL,
  display_name text NOT NULL,
  reply_to text,
  PRIMARY KEY (owner_did, purpose, app_did),
  CONSTRAINT mail_senders_purpose_check
    CHECK (purpose IN ('signin', 'receipts', 'notifications', 'contact'))
);
