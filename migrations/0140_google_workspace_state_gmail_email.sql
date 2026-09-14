-- Migration: 0140_google_workspace_state_gmail_email
-- owner: kernel
-- Renumbered from 0137 (post-#2162/#2160 rebase): 0137 collided with the
-- independently merged 0138/0139 registry_apps migrations once main advanced.
-- Adds the Gmail address reverse-index column to kernel.google_workspace_state
-- (#2144, PR 2/2). Google's Pub/Sub push payload names the mailbox by address,
-- not by DID, so the webhook route (POST /google/api/webhook/gmail) needs this
-- column to resolve which ownerDid a given push notification belongs to.

ALTER TABLE kernel.google_workspace_state
  ADD COLUMN IF NOT EXISTS gmail_email_address text;

CREATE INDEX IF NOT EXISTS idx_google_workspace_state_gmail_email
  ON kernel.google_workspace_state (gmail_email_address);
