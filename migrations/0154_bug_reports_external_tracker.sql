-- 0154_bug_reports_external_tracker.sql
-- owner: kernel
--
-- #2184: de-vendor www.bug_reports' GitHub-specific issue columns into a
-- generic tracker discriminator + external ref/url — the same shape already
-- used elsewhere for a neutral table pointing at a vendor system (e.g.
-- media.receipts.{scheme, external_receipt_id}, usage.billed.provider).
--
-- ADDITIVE ONLY. This migration adds tracker/external_ref/external_url and
-- backfills them from the existing github_issue_number/github_issue_url
-- columns; it does NOT drop those two columns. The destructive drop is a
-- SEPARATE follow-on migration (0155_bug_reports_drop_github_columns.sql) in
-- the same PR, so there is an explicit rollback point between the two: if
-- 0155 has not run yet, the old two-column shape is still intact and any
-- pre-#2184 read path still works unmodified.
--
-- Backfill note: every historical imported row was created against a single
-- hardcoded repo (`ima-jin/imajin-ai`, formerly the `GITHUB_REPO` env var
-- read by app/api/bugs/[id]/import/route.ts) — there is no per-row repo to
-- recover, so that literal is used to reconstruct `external_ref`.

ALTER TABLE www.bug_reports ADD COLUMN IF NOT EXISTS tracker text;
ALTER TABLE www.bug_reports ADD COLUMN IF NOT EXISTS external_ref text;
ALTER TABLE www.bug_reports ADD COLUMN IF NOT EXISTS external_url text;

UPDATE www.bug_reports
SET tracker = 'github',
    external_ref = 'ima-jin/imajin-ai#' || github_issue_number,
    external_url = github_issue_url
WHERE github_issue_number IS NOT NULL
  AND tracker IS NULL;

CREATE INDEX IF NOT EXISTS idx_bug_reports_tracker ON www.bug_reports (tracker);
