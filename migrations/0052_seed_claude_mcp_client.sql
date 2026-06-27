-- 0052_seed_claude_mcp_client.sql
-- Pre-register the Claude Desktop MCP connector as an OAuth client (Issue #1166).
-- No Dynamic Client Registration — this row IS the client. Its `id` is the
-- OAuth client_id; `callback_url` is the exact (allowlisted) redirect_uri.
--
-- NOTE: public_key is a non-functional placeholder. Claude is a PUBLIC client
-- (PKCE, no proof-of-possession), so its key is never used by the OAuth flow;
-- the column is NOT NULL/UNIQUE so we store a placeholder, not a real keypair.

INSERT INTO registry.apps (
  id,
  owner_did,
  name,
  description,
  app_did,
  public_key,
  callback_url,
  homepage_url,
  requested_scopes,
  status,
  created_at,
  updated_at
) VALUES (
  'app_claude_desktop',                                                  -- client_id
  'did:imajin:platform',                                                 -- first-party owner
  'Claude Desktop',
  'Anthropic Claude Desktop — read-only media MCP connector (#1166)',
  'did:imajin:claude-desktop',                                           -- azp in minted tokens
  'c1a0dec0ffeec1a0dec0ffeec1a0dec0ffeec1a0dec0ffeec1a0dec0ffeedead',    -- placeholder (unused; public client)
  'https://claude.ai/api/mcp/auth_callback',                             -- allowlisted redirect_uri
  'https://claude.ai',
  '["media:read"]'::jsonb,                                               -- read-only
  'active',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;
