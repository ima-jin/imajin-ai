-- owner: kernel
-- Public alpha intake; append-only requests, never identities or sign-up.
CREATE SCHEMA IF NOT EXISTS www;

CREATE TABLE IF NOT EXISTS www.alpha_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  email varchar(254) NOT NULL,
  company varchar(200) NOT NULL,
  intent varchar(16) NOT NULL,
  purpose varchar(1000) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alpha_submissions_intent_check CHECK (intent IN ('tester', 'integrator', 'partner', 'demo'))
);

CREATE INDEX IF NOT EXISTS idx_alpha_submissions_created
  ON www.alpha_submissions (created_at, id);
CREATE INDEX IF NOT EXISTS idx_alpha_submissions_intent_created
  ON www.alpha_submissions (intent, created_at, id);
