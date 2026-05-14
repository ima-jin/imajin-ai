-- Campaign events: goal-based crowdfunding
-- Issue #749

-- Add campaign fields to events
ALTER TABLE events.events ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'event';
ALTER TABLE events.events ADD COLUMN IF NOT EXISTS target_amount INTEGER;
ALTER TABLE events.events ADD COLUMN IF NOT EXISTS deadline TIMESTAMPTZ;

-- Pledges table
CREATE TABLE IF NOT EXISTS events.pledges (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events.events(id),
  backer_did TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  stripe_setup_intent_id TEXT,
  stripe_payment_method_id TEXT,
  stripe_customer_id TEXT,
  mjnx_escrow_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  charged_at TIMESTAMPTZ,
  failure_reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pledges_event ON events.pledges(event_id);
CREATE INDEX IF NOT EXISTS idx_pledges_backer ON events.pledges(backer_did);
CREATE INDEX IF NOT EXISTS idx_pledges_status ON events.pledges(status);
