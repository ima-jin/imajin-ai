-- 0164_app_provisions.sql
-- owner: kernel
-- apps.provision (#2375) — the durable, per-slug provisioning ledger.
--
-- One row per slug, not per attempt: this is both the idempotency record
-- ("re-run returns the existing repo/DID, does not re-create") and the
-- fail-closed record ("any step failing after repo creation leaves a
-- provision.failed record naming the step"). Each step column is set only
-- once that step has actually succeeded, so a retry after a failure can
-- skip every step that already completed and resume at `failed_step`.
--
-- Never holds secret material — only names/urls/booleans/timestamps.

CREATE TABLE IF NOT EXISTS kernel.app_provisions (
  slug              TEXT PRIMARY KEY,
  app_did           TEXT,
  repo_url          TEXT,
  -- true when this run created the repo; false when an existing repo (e.g.
  -- dykil's already-cloned ima-jin/dykil) was found and reused.
  repo_created      BOOLEAN,
  registered_at     TIMESTAMPTZ,
  sealed_at         TIMESTAMPTZ,
  -- Actions secret NAMES only (e.g. ["IMAJIN_APP_PRIVATE_KEY", "GITHUB_PACKAGES_TOKEN"]) — never values.
  secrets_set       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Namespaced attestation types seeded at provision time (e.g. ["dykil/survey-response"]).
  attestation_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  status            TEXT NOT NULL DEFAULT 'pending',
  failed_step       TEXT,
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE kernel.app_provisions
  DROP CONSTRAINT IF EXISTS app_provisions_status_check;

ALTER TABLE kernel.app_provisions
  ADD CONSTRAINT app_provisions_status_check CHECK (status IN ('pending', 'succeeded', 'failed'));

CREATE INDEX IF NOT EXISTS idx_app_provisions_status ON kernel.app_provisions (status);
