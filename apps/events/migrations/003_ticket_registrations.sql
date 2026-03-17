-- Migration 003: Per-ticket registration support
-- Adds registration fields to ticket_types, tickets, and events tables,
-- and creates the ticket_registrations table.

-- ticket_types: registration fields
ALTER TABLE events.ticket_types
  ADD COLUMN IF NOT EXISTS requires_registration BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE events.ticket_types
  ADD COLUMN IF NOT EXISTS registration_form_id TEXT;

-- tickets: registration status
ALTER TABLE events.tickets
  ADD COLUMN IF NOT EXISTS registration_status TEXT NOT NULL DEFAULT 'not_required';

CREATE INDEX IF NOT EXISTS idx_tickets_registration_status
  ON events.tickets (registration_status);

-- events: registration config
ALTER TABLE events.events
  ADD COLUMN IF NOT EXISTS registration_config JSONB NOT NULL DEFAULT '{}';

-- ticket_registrations table
CREATE TABLE IF NOT EXISTS events.ticket_registrations (
  id                  TEXT PRIMARY KEY,
  ticket_id           TEXT NOT NULL REFERENCES events.tickets(id) ON DELETE CASCADE,
  event_id            TEXT NOT NULL REFERENCES events.events(id),
  name                TEXT NOT NULL,
  email               TEXT NOT NULL,
  form_id             TEXT NOT NULL,
  response_id         TEXT,
  registered_by_did   TEXT,
  registered_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_registrations_ticket
  ON events.ticket_registrations (ticket_id);

CREATE INDEX IF NOT EXISTS idx_ticket_registrations_event
  ON events.ticket_registrations (event_id);

CREATE INDEX IF NOT EXISTS idx_ticket_registrations_email
  ON events.ticket_registrations (email);
