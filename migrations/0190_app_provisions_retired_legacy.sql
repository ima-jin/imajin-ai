-- owner: kernel
-- #2810: retain cutover provenance across failed attempts and approved retries.
-- Generated with drizzle-kit from the app_provisions schema; made idempotent
-- for the unified migration runner. No userspace app schema/data is touched.
ALTER TABLE "kernel"."app_provisions" ADD COLUMN IF NOT EXISTS "retired_legacy_app_id" text;
