-- Added in PR #880 (events follow-up #3) for EMT confirm email fallback chain.
-- Originally only present as a comment in apps/events/src/db/schema.ts:144.
ALTER TABLE events.orders ADD COLUMN IF NOT EXISTS buyer_email TEXT;
