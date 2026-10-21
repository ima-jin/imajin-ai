-- 0040_calendar_entries.sql
-- Calendar primitive — kernel-level temporal entries (Issue #241, minimal slice)
-- Base type-agnostic row that availability intent (#1099), meetings, events,
-- bookings, and reminders all build on. Broker-gated visibility.

CREATE SCHEMA IF NOT EXISTS kernel;

CREATE TABLE IF NOT EXISTS kernel.calendar_entries (
  id              TEXT PRIMARY KEY,
  did             TEXT NOT NULL,                          -- owner DID
  type            TEXT NOT NULL,                          -- 'availability' | 'meeting' | 'event' | 'booking' | 'reminder' | 'block'
  title           TEXT,                                   -- optional display title
  activity_tags   TEXT[],                                 -- ['board_games', 'party', 'cycling', 'dinner']
  starts_at       TIMESTAMPTZ,                            -- null = open-ended
  ends_at         TIMESTAMPTZ,                            -- null = open-ended
  expires_at      TIMESTAMPTZ,                            -- TTL — auto-cleanup for transient entries
  visibility      TEXT NOT NULL DEFAULT 'private',        -- 'public' | 'connections' | 'selective' | 'private'
  visibility_dids TEXT[],                                 -- for selective: specific DIDs that can see this
  recurrence      JSONB,                                  -- future: rrule-style recurrence
  metadata        JSONB NOT NULL DEFAULT '{}',            -- type-specific data (location, notes, booking ref, etc.)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_entries_did
  ON kernel.calendar_entries (did);

CREATE INDEX IF NOT EXISTS idx_calendar_entries_did_time
  ON kernel.calendar_entries (did, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS idx_calendar_entries_type
  ON kernel.calendar_entries (did, type);

CREATE INDEX IF NOT EXISTS idx_calendar_entries_expires
  ON kernel.calendar_entries (expires_at)
  WHERE expires_at IS NOT NULL;
