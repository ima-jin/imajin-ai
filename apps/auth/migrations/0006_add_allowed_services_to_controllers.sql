-- Add per-controller service scoping
-- NULL/empty = full access (backwards compatible), populated = restricted to listed services
ALTER TABLE auth.group_controllers
  ADD COLUMN IF NOT EXISTS allowed_services TEXT[] DEFAULT NULL;
