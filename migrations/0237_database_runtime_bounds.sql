-- owner: kernel
-- Runtime-only change: shared client startup parameters now bound statements
-- and idle transactions per connection. No persistent role/database defaults:
-- migrations and explicitly opted-out workers must retain their own policy.
-- This idempotent companion records that no schema/data rewrite is required.
SELECT 1;
