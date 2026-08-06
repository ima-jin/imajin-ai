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
 *
 * Publishing also widens the owner's active DCR client registrations (#1647) so
 * the newly toggled scopes survive the token-refresh intersection — without it
 * Gate 1 (the JWT `scope` claim) stays frozen at registration time forever.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishMcpScopeManifest,
  readActiveMcpScopes,
  findMcpManifestAsset,
  widenMcpClientScopes,
  VALID_MCP_SCOPES,
} from '@/src/lib/mcp/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'MCP',
  validScopes: VALID_MCP_SCOPES,
  findManifestAsset: findMcpManifestAsset,
  readActiveScopes: readActiveMcpScopes,
  publish: async (ownerDid, scopes) => {
    const assetId = await publishMcpScopeManifest(ownerDid, scopes);
    // Widen client registrations so the next token refresh picks up new scopes (#1647).
    // Fire-and-forget: publish succeeded; widen failure is degraded, not fatal.
    widenMcpClientScopes(ownerDid, scopes).catch(() => { /* logged inside */ });
    return assetId;
  },
  // No getExtraFields — native connector has no credentials to report.
});
