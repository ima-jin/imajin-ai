CREATE TABLE IF NOT EXISTS www.bug_reports (
  id TEXT PRIMARY KEY,
  reporter_did TEXT NOT NULL,
  reporter_name TEXT,
  reporter_email TEXT,
  type TEXT NOT NULL DEFAULT 'bug',
  description TEXT NOT NULL,
  screenshot_url TEXT,
  page_url TEXT,
  user_agent TEXT,
  viewport TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  github_issue_number INTEGER,
  github_issue_url TEXT,
  admin_notes TEXT,
  duplicate_of TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_reporter ON www.bug_reports(reporter_did);
CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON www.bug_reports(status);
