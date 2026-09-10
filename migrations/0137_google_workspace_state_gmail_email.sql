-- Migration: 0137_google_workspace_state_gmail_email
-- owner: kernel
-- Renumbered from 0134 (#2144 hotfix): 0134 collided with the independently
-- merged 0134_pay_balance_units_drop_legacy_columns.sql once both PRs landed on main.
-- Adds the Gmail address reverse-index column to kernel.google_workspace_state
-- (#2144, PR 2/2). Google's Pub/Sub push payload names the mailbox by address,
-- not by DID, so the webhook route (POST /google/api/webhook/gmail) needs this
-- column to resolve which ownerDid a given push notification belongs to.

ALTER TABLE kernel.google_workspace_state
  ADD COLUMN IF NOT EXISTS gmail_email_address text;

CREATE INDEX IF NOT EXISTS idx_google_workspace_state_gmail_email
  ON kernel.google_workspace_state (gmail_email_address);
