-- 0155_bug_reports_drop_github_columns.sql
-- owner: kernel
--
-- #2184: DESTRUCTIVE follow-on to 0154_bug_reports_external_tracker.sql.
--
-- 0154 added the generic tracker/external_ref/external_url columns and
-- backfilled them from github_issue_number/github_issue_url, leaving the old
-- columns in place as a rollback point. Every reader/writer in this PR
-- (app/api/bugs/[id]/import/route.ts, src/lib/github/bug-import.ts,
-- app/bugs/page.tsx, app/bugs/admin/page.tsx, src/db/schemas/www.ts) now
-- reads/writes exclusively through tracker/external_ref/external_url —
-- verified via `git grep -i github_issue apps/kernel` returning nothing but
-- this migration pair and BASELINE history — so the old columns are dead and
-- safe to drop here rather than left for a later cleanup.
--
-- Rollback story: reverting this single file (re-adding the two columns and
-- backfilling them from external_ref/external_url) is sufficient to restore
-- the old shape without touching 0154 — that migration is safe to leave
-- applied.

ALTER TABLE www.bug_reports DROP COLUMN IF EXISTS github_issue_number;
ALTER TABLE www.bug_reports DROP COLUMN IF EXISTS github_issue_url;
