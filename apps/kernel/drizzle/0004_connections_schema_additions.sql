-- connections.connections table (first-class, replaces 2-person pods)
CREATE TABLE IF NOT EXISTS connections.connections (
  did_a TEXT NOT NULL,
  did_b TEXT NOT NULL,
  connected_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  disconnected_at TIMESTAMPTZ,
  PRIMARY KEY (did_a, did_b)
);
CREATE INDEX IF NOT EXISTS connections_did_a_idx ON connections.connections (did_a);
CREATE INDEX IF NOT EXISTS connections_did_b_idx ON connections.connections (did_b);

-- connections.nicknames table
CREATE TABLE IF NOT EXISTS connections.nicknames (
  did TEXT NOT NULL,
  target TEXT NOT NULL,
  nickname TEXT NOT NULL,
  PRIMARY KEY (did, target)
);

-- Missing columns on invites (accumulated from forest sprint + kernel merge)
ALTER TABLE connections.invites ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
ALTER TABLE connections.invites ADD COLUMN IF NOT EXISTS to_phone TEXT;
ALTER TABLE connections.invites ADD COLUMN IF NOT EXISTS to_did TEXT;
ALTER TABLE connections.invites ADD COLUMN IF NOT EXISTS delivery TEXT NOT NULL DEFAULT 'link';
ALTER TABLE connections.invites ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE connections.invites ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE connections.invites ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE connections.invites ADD COLUMN IF NOT EXISTS role TEXT;
