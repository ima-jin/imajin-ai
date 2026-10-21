-- 0139_registry_apps_seed_first_party.sql
-- owner: kernel
-- Register every first-party app as the first consumers of the #1990
-- registry (0138_registry_apps_registry_fields.sql) — same path a
-- third-party app would go through: a registry.apps row with a tier,
-- token audience(s), and allowed redirect host(s).
--
-- Deployment topology note (see docs/security/cookie-isolation.md's own
-- "honest unknowns" #1 and every NEXT_PUBLIC_*_URL in
-- apps/kernel/.env.example): this is a single-origin, path-routed
-- deployment (`your-node.imajin.ai/coffee`, `/dykil`, ...), not real
-- per-app subdomains. A literal DNS-hostname allowlist would therefore be
-- the SAME value for every first-party app and would hardcode one node's
-- domain into a migration every self-hosted node runs. `token_audiences` /
-- `allowed_redirect_hosts` are seeded instead with the short scope id
-- already used elsewhere in this codebase for these exact apps
-- (registry.interests.scope: 'coffee' | 'dykil' | 'links' | 'learn' |
-- 'events' | 'market'), plus 'jin' for the neutral shell itself. An
-- operator running real per-app subdomains can register the actual hosts
-- via the admin registry surface (POST/PATCH /api/admin/registry/apps)
-- without a migration.
--
-- publicKey is a per-row unique, non-functional placeholder (same pattern
-- as 0052_seed_claude_mcp_client.sql's DCR placeholder): first-party apps
-- authenticate callers via the session-app-token path
-- (POST /auth/api/tokens/app, #1069 Phase 1), never the third-party
-- DID+proof-of-possession path, so there is no real signing key to seed.
-- An operator can mint one later via POST /api/admin/registry/apps/:id/rotate
-- if a first-party app ever needs one.

INSERT INTO registry.apps (
  id, owner_did, name, description, app_did, public_key,
  callback_url, requested_scopes, status, tier,
  allowed_redirect_hosts, token_audiences
)
VALUES
  ('app_first_party_coffee', 'did:imajin:platform', 'Coffee',
   'Tipping/support pages (first-party, #1990)', 'did:imajin:app-coffee',
   'firstparty_placeholder_coffee_0000000000000000000000000000000000000000',
   'https://your-node.imajin.ai/coffee', '[]', 'active', 'first_party',
   ARRAY['coffee'], ARRAY['coffee']),

  ('app_first_party_dykil', 'did:imajin:platform', 'Dykil',
   'Community spending surveys (first-party, #1990)', 'did:imajin:app-dykil',
   'firstparty_placeholder_dykil_00000000000000000000000000000000000000000',
   'https://your-node.imajin.ai/dykil', '[]', 'active', 'first_party',
   ARRAY['dykil'], ARRAY['dykil']),

  ('app_first_party_links', 'did:imajin:platform', 'Links',
   'Link-in-bio pages (first-party, #1990)', 'did:imajin:app-links',
   'firstparty_placeholder_links_00000000000000000000000000000000000000000',
   'https://your-node.imajin.ai/links', '[]', 'active', 'first_party',
   ARRAY['links'], ARRAY['links']),

  ('app_first_party_learn', 'did:imajin:platform', 'Learn',
   'Courses/enrollment (first-party, #1990)', 'did:imajin:app-learn',
   'firstparty_placeholder_learn_00000000000000000000000000000000000000000',
   'https://your-node.imajin.ai/learn', '[]', 'active', 'first_party',
   ARRAY['learn'], ARRAY['learn']),

  ('app_first_party_events', 'did:imajin:platform', 'Events',
   'Events & ticketing (first-party, #1990)', 'did:imajin:app-events',
   'firstparty_placeholder_events_0000000000000000000000000000000000000000',
   'https://your-node.imajin.ai/events', '[]', 'active', 'first_party',
   ARRAY['events'], ARRAY['events']),

  ('app_first_party_market', 'did:imajin:platform', 'Market',
   'Local commerce (first-party, #1990)', 'did:imajin:app-market',
   'firstparty_placeholder_market_0000000000000000000000000000000000000000',
   'https://your-node.imajin.ai/market', '[]', 'active', 'first_party',
   ARRAY['market'], ARRAY['market']),

  ('app_first_party_jin', 'did:imajin:platform', 'Jin',
   'Neutral shell — auth, pay, profile, connections, chat, media, notify (first-party, #1990)',
   'did:imajin:app-jin',
   'firstparty_placeholder_jin_000000000000000000000000000000000000000000',
   'https://your-node.imajin.ai', '[]', 'active', 'first_party',
   ARRAY['jin'], ARRAY['jin'])
ON CONFLICT (id) DO NOTHING;
