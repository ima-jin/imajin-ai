-- #2957: private discovery need not forbid direct-link sign-in.
-- owner: kernel
ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS sign_in_audience text NOT NULL DEFAULT 'members';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'registry_apps_sign_in_audience_check'
      AND conrelid = 'registry.apps'::regclass
  ) THEN
    ALTER TABLE registry.apps ADD CONSTRAINT registry_apps_sign_in_audience_check
      CHECK (sign_in_audience IN ('members', 'anyone'));
  END IF;
END $$;
