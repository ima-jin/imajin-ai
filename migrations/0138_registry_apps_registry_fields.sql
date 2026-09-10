-- 0138_registry_apps_registry_fields.sql
-- owner: kernel
-- App registry as a first-class table (#1990): apps become identities the
-- kernel refuses to serve unregistered. Extends the existing registry.apps
-- table (0007_registry_apps.sql, Issue #244) — already the source of truth
-- for third-party app DIDs/keys and consumed by the app-token mint/verify
-- routes (#1069 Phase 1, PR #1974) — with the fields #1990 requires: tier,
-- allowed redirect hosts, and token audience(s). Additive only.
--
-- `tier` distinguishes first-party apps (coffee, dykil, links, learn, events,
-- market, jin — seeded in 0139) from third-party apps (OAuth DCR clients,
-- Delegated App Sessions registrations).
--
-- `allowed_redirect_hosts` is the SET of origins (scheme://host[:port]) this
-- app may redirect a user back to. Folds in #1348's "store the full set, not
-- just the first" fix at origin granularity: DCR registration (#1878) now
-- populates every distinct redirect_uri origin here, not just
-- callback_url's single origin.
--
-- `token_audiences` is the set of `aud` values this app is allowed to have
-- scoped app-tokens minted or verified for (#1069's createSessionAppToken /
-- createAppToken `aud` claim). Before this, POST /auth/api/tokens/app would
-- mint a token scoped to ANY caller-supplied string — this column is what
-- the kernel checks that audience against.

ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'third_party',
  ADD COLUMN IF NOT EXISTS allowed_redirect_hosts TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS token_audiences TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE registry.apps
  DROP CONSTRAINT IF EXISTS registry_apps_tier_check;

ALTER TABLE registry.apps
  ADD CONSTRAINT registry_apps_tier_check CHECK (tier IN ('first_party', 'third_party'));

CREATE INDEX IF NOT EXISTS idx_registry_apps_tier ON registry.apps (tier);

-- GIN index for the `token_audiences @> ARRAY[aud]` containment lookup the
-- mint/verify enforcement routes perform on every call.
CREATE INDEX IF NOT EXISTS idx_registry_apps_token_audiences ON registry.apps USING GIN (token_audiences);
