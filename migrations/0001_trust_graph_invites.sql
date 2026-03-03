-- Migration: Add trust graph invite system with cooldown

-- Add trust_graph_invites table
CREATE TABLE IF NOT EXISTS trust_graph_invites (
  id TEXT PRIMARY KEY,
  inviter_did TEXT NOT NULL,
  invitee_email TEXT,
  invitee_did TEXT,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trust_graph_invites_inviter ON trust_graph_invites(inviter_did);
CREATE INDEX IF NOT EXISTS idx_trust_graph_invites_email ON trust_graph_invites(invitee_email);
CREATE INDEX IF NOT EXISTS idx_trust_graph_invites_did ON trust_graph_invites(invitee_did);
CREATE INDEX IF NOT EXISTS idx_trust_graph_invites_status ON trust_graph_invites(status);

-- Add next_invite_available_at to profiles table
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS next_invite_available_at TIMESTAMPTZ;

-- Add comment to clarify the column purpose
COMMENT ON COLUMN profiles.next_invite_available_at IS 'NULL = can invite now, otherwise timestamp when next invite is available';
