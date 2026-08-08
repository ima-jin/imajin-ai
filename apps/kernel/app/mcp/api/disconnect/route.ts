/**
 * POST + OPTIONS /mcp/api/disconnect (#1592)
 *
 * Revoke-all for the native MCP connector. There is no credential to purge —
 * the scope grants ARE the connection — so this publishes the owner's MCP
 * scope-manifest with an empty scope set and then confirms that every
 * `auth.channel_links` row for `channel = mcp` has flipped to `revoked`.
 *
 * Reuses `publishMcpScopeManifest`, the exact publisher the scope toggles use,
 * so revoking travels the same manifest → consent_grants → channel_links rail as
 * granting. All the disconnect-specific behaviour (residual-row sweep, verify,
 * fail-closed error reporting, bus event) lives in the shared factory.
 *
 * Not done here, on purpose: narrowing the `requestedScopes` that #1647 widened
 * on the owner's DCR client registrations. Those feed Gate 1 (the JWT `scope`
 * claim); Gate 2 is the `channel_links` row this route revokes, and every MCP
 * tool call passes through `requireMcpGrant`, so access stops immediately either
 * way. Narrowing registrations is the same asymmetry a single toggle-off already
 * has and belongs with that work, not with this button.
 */
import { createNativeDisconnectHandler } from '@/src/lib/kernel/connector-native-disconnect';
import { publishMcpScopeManifest, readActiveMcpScopes } from '@/src/lib/mcp/scope-manifest';
import { MCP_CONNECTOR_DID, MCP_CHANNEL } from '@/src/lib/mcp/oauth-config';

export const { POST, OPTIONS } = createNativeDisconnectHandler({
  channel: MCP_CHANNEL,
  connectorDid: MCP_CONNECTOR_DID,
  connectorName: 'mcp',
  publishScopeManifest: publishMcpScopeManifest,
  readActiveScopes: readActiveMcpScopes,
});
