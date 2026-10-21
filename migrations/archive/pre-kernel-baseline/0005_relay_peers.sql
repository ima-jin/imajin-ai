-- 0004_relay_peers.sql
-- Admin-configurable relay peer management (#729)

CREATE TABLE IF NOT EXISTS relay.relay_peers (
  peer_url   TEXT PRIMARY KEY,
  push       INTEGER NOT NULL DEFAULT 1,
  "fetch"    INTEGER NOT NULL DEFAULT 1,
  sync       INTEGER NOT NULL DEFAULT 1,
  enabled    INTEGER NOT NULL DEFAULT 1,
  label      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
