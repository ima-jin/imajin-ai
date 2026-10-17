-- 0053_promote_claude_actor.sql
-- Promote the Claude Desktop OAuth client from a registry.apps credential into a
-- first-class actor DID member of the graph (#1171). The registry.apps row (0052)
-- STAYS — it is now understood as the OAuth "adapter binding" pointing at this
-- actor DID, not the identity itself.
--
-- Raw INSERT on purpose (NO `identity.created` event): agent actors are not
-- economic onboarding events, so this must not trigger the MJN-emission / forest
-- reactors wired to identity.created (#1171 Correction 2).
--
-- Keyless OAuth public client → a non-curve `agent_` sentinel public_key, and
-- subtype 'agent' (treated as non-signing). Handle is left NULL so the agent can
-- never collide with or impersonate a human handle (#1171 Correction 3 + handle
-- policy). Derived from the adapter row so it only promotes a client that exists.

INSERT INTO auth.identities (
  id,
  scope,
  subtype,
  public_key,
  handle,
  name,
  avatar_url,
  metadata,
  created_at,
  updated_at
)
SELECT
  a.app_did,                                   -- 'did:imajin:claude-desktop' becomes the actor DID
  'actor',
  'agent',
  'agent_' || a.id,                            -- non-signing sentinel key (unique): agent_app_claude_desktop
  NULL,                                        -- no handle: avoid human-namespace collision / impersonation
  a.name,                                      -- 'Claude Desktop'
  a.logo_url,                                  -- adapter logo if present (NULL otherwise)
  jsonb_build_object(
    'agent', true,
    'client', true,
    'adapter', 'oauth',
    'adapterAppId', a.id
  ),
  NOW(),
  NOW()
FROM registry.apps a
WHERE a.id = 'app_claude_desktop'
ON CONFLICT (id) DO NOTHING;
