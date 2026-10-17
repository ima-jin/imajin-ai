-- 0092_agrifortress_app_scopes.sql
-- Add missing requested scopes to the AgriFortress (XPRIZE integrity) app
-- registration (#1823).
--
-- prod-integrity's app row (`app_96v2Sfpt_KlxiYFi`, DID
-- `did:imajin:4uf86uiGzS4V9aQ8oyjrKYEcbzLeS1DTjH9e7Z7uF7J`) only had
-- `connections:read` in `requested_scopes`, so:
--   - `identity.invites.create` 403'd: 403 Scope 'connections:write' was not
--     granted
--   - the counterparty delivery notification 401'd: `chat.conversations.create`
--     needs `chat:write` (added to the vocabulary alongside this migration,
--     see packages/auth/src/scope-vocabulary.ts)
--   - countersign 401'd: needs `attestations:write` (see #1824 for the
--     countersign-endpoint auth-path follow-up)
--
-- Registering these here — rather than a prod DB poke — makes the fix
-- durable across re-seeds and new environments, following the same
-- add-a-scope-to-an-existing-app shape as 0054_claude_media_write_scope.sql.
--
-- Idempotent: only adds scopes that aren't already present. A no-op where
-- this app row doesn't exist (e.g. local/dev, where it is registered
-- dynamically via POST /api/registry/apps rather than seeded).

UPDATE registry.apps
SET requested_scopes = (
  SELECT jsonb_agg(DISTINCT s)
  FROM jsonb_array_elements_text(
    requested_scopes || '["connections:write","chat:write","attestations:write"]'::jsonb
  ) AS s
)
WHERE id = 'app_96v2Sfpt_KlxiYFi'
  AND NOT (requested_scopes @> '["connections:write","chat:write","attestations:write"]'::jsonb);
