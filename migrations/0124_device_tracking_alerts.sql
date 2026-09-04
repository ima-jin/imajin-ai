-- 0124_device_tracking_alerts.sql
-- Device tracking & new-device login alerts (#306, parent #257).
--
-- auth.devices already exists (migrations/0001_seed.sql) with
-- id/did/fingerprint/name/ip/user_agent/trusted/first_seen_at/last_seen_at.
-- This migration brings it up to #306's full schema:
--
-- platform  - parsed from the User-Agent at login time (e.g. "macOS").
-- browser   - parsed from the User-Agent at login time (e.g. "Chrome").
-- city      - IP-derived city, nullable. No geo-IP source exists in this
--             repo yet (#306 explicitly scopes that out) — always NULL
--             until one is added, at which point it is backfillable
--             without another migration.
-- country   - IP-derived country, nullable. Same as city above.
-- revoked   - soft-delete flag. DELETE /api/devices/:id now marks a device
--             revoked rather than removing the row, so the login history
--             (first_seen_at/last_seen_at) survives a revoke as an audit
--             trail — only the "known devices" list view hides it.
--
-- `ip` stays TEXT (not INET, despite the issue body's schema sketch):
-- `x-forwarded-for` can legitimately be a comma-separated chain or an
-- operator-injected non-canonical value, and this column has never been
-- used for anything but display — casting it to INET would risk insert
-- failures on exactly the malformed-header cases device tracking most
-- wants to keep recording. Same reasoning for keeping `did` (not renaming
-- to `identity_did`) and `fingerprint` (not `fingerprint_hash`) — matching
-- the columns @/src/lib/auth/log-device.ts and the existing GET/DELETE/trust
-- routes already read/write today.

ALTER TABLE auth.devices
  ADD COLUMN IF NOT EXISTS platform TEXT,
  ADD COLUMN IF NOT EXISTS browser  TEXT,
  ADD COLUMN IF NOT EXISTS city     TEXT,
  ADD COLUMN IF NOT EXISTS country  TEXT,
  ADD COLUMN IF NOT EXISTS revoked  BOOLEAN NOT NULL DEFAULT false;

-- Fast "list my active devices" query (GET /api/devices excludes revoked).
CREATE INDEX IF NOT EXISTS idx_devices_did_active
  ON auth.devices (did, last_seen_at DESC)
  WHERE revoked = false;
