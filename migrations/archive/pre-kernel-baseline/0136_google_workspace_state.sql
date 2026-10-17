-- Migration: 0136_google_workspace_state
-- owner: kernel
-- Google Workspace connector operational state (#2144).
--
-- One row per connecting DID. Distinct from auth.channel_links (authoritative
-- for grants) and the vault (authoritative for the sealed refresh token): this
-- table holds small, non-secret cursors the connector needs between calls —
--
--   gmail_history_id / gmail_watch_expiration — the Gmail users.watch push
--     subscription's last-seen historyId and renewal deadline (a watch expires
--     after 7 days; the renewal cron reads this column).
--   drive_page_token — the Drive changes.list page-token cursor for the
--     on-demand google_drive_list_changes tool.
--
-- Nothing here is credential-grade — losing this table costs a full resync,
-- not a security incident.

CREATE TABLE IF NOT EXISTS kernel.google_workspace_state (
  id                      text        PRIMARY KEY,          -- gws_{nanoid}
  owner_did               text        NOT NULL,
  gmail_history_id        text,
  gmail_watch_expiration  timestamptz,
  drive_page_token        text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_google_workspace_state_owner
  ON kernel.google_workspace_state (owner_did);
