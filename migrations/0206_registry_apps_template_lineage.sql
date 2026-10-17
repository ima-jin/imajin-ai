-- 0206_registry_apps_template_lineage.sql — #2905: registry-driven template cascades.
-- owner: kernel
ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS source_repo text,
  ADD COLUMN IF NOT EXISTS template text,
  ADD COLUMN IF NOT EXISTS template_ref text,
  ADD COLUMN IF NOT EXISTS template_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS joined boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_registry_apps_template ON registry.apps (template);

-- Extractions are third_party identities, not the retired first_party seeds.
-- Bind their repo through the provisioning ledger, never through a third-party
-- slug alone. A node without the extraction keeps its active legacy seed.
-- Unknown last-synced refs/times remain NULL until an app reports them.
UPDATE registry.apps AS app
SET source_repo = 'ima-jin/' || derived.slug,
    template = 'ima-jin/imajin-app-template',
    joined = true
FROM (VALUES ('coffee'), ('dykil'), ('events'), ('learn'), ('links'), ('market')) AS derived(slug)
WHERE app.status = 'active'
  AND (
    app.id = 'app_first_party_' || derived.slug
    OR EXISTS (
      SELECT 1 FROM kernel.app_provisions provision
      WHERE provision.app_did = app.app_did
        AND provision.slug = derived.slug
        AND provision.repo_url = 'https://github.com/ima-jin/' || derived.slug
    )
  );

-- Pending adopters must be discoverable by the same query so the cascade can
-- open one join issue instead of silently omitting them. Absent registrations
-- are not fabricated here; new rows default to joined=false.
UPDATE registry.apps AS app
SET source_repo = 'ima-jin/' || candidate.slug,
    template = 'ima-jin/imajin-app-template',
    joined = false
FROM (VALUES ('scorecard'), ('karaoke'), ('fixready')) AS candidate(slug)
WHERE app.status = 'active'
  AND (
    app.id = 'app_first_party_' || candidate.slug
    OR EXISTS (
      SELECT 1 FROM kernel.app_provisions provision
      WHERE provision.app_did = app.app_did
        AND provision.slug = candidate.slug
        AND provision.repo_url = 'https://github.com/ima-jin/' || candidate.slug
    )
  );
