-- 0054_claude_media_write_scope.sql
-- Add 'media:write' to the Claude Desktop OAuth client's registered scopes (#1170).
--
-- 0052 registered the client read-only (requested_scopes = ["media:read"]). The
-- consent flow grants requested ∩ MCP-supported ∩ client-registered, so the
-- create-only (#1182) + owner-update (#1183) write tools are NOT grantable until
-- 'media:write' is in the client's registered set. This makes write grantable;
-- the user still has to explicitly consent to it on the consent screen (#1182),
-- and read-grant never implies write-grant (enforced per-tool by requiredScope).
--
-- Idempotent: only adds the scope if it isn't already present.

UPDATE registry.apps
SET requested_scopes = (
  SELECT jsonb_agg(DISTINCT s)
  FROM jsonb_array_elements_text(requested_scopes || '["media:write"]'::jsonb) AS s
)
WHERE id = 'app_claude_desktop'
  AND NOT (requested_scopes @> '["media:write"]'::jsonb);
