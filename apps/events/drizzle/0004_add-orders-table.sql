-- Create orders table
CREATE TABLE IF NOT EXISTS events.orders (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events.events(id),
  buyer_did TEXT,
  ticket_type_id TEXT NOT NULL REFERENCES events.ticket_types(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  amount_total INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  payment_method TEXT,
  stripe_session_id TEXT,
  payment_id TEXT,
  fair_settlement JSONB,
  purchased_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_orders_event ON events.orders(event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON events.orders(buyer_did);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_orders_stripe_session ON events.orders(stripe_session_id);
--> statement-breakpoint
-- Add order_id to tickets (nullable for legacy tickets)
ALTER TABLE events.tickets ADD COLUMN IF NOT EXISTS order_id TEXT REFERENCES events.orders(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tickets_order ON events.tickets(order_id);
