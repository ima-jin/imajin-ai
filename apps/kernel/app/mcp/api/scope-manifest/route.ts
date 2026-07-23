/**
 * GET + POST /mcp/api/scope-manifest (#1394 child 1)
 *
 * Wires the shared scope-manifest route factory for the native MCP connector.
 * No credential booleans in the response — native connectors require no credential.
 * GET returns { manifestAssetId, activeScopes, validScopes }.
 * POST validates scopes fail-closed, publishes, returns { published, assetId, activeScopes }.
 *
 * Scope materialisation:
 *   media:read, connections:read → silent      (active immediately after POST)
 *   media:write, media:share     → on-consent  (needs consent_grants row)
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishMcpScopeManifest,
  readActiveMcpScopes,
  findMcpManifestAsset,
  VALID_MCP_SCOPES,
} from '@/src/lib/mcp/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'MCP',
  validScopes: VALID_MCP_SCOPES,
  findManifestAsset: findMcpManifestAsset,
  readActiveScopes: readActiveMcpScopes,
  publish: publishMcpScopeManifest,
  // No getExtraFields — native connector has no credentials to report.
});
