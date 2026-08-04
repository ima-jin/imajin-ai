/**
 * MCP (native) connector scope-manifest publisher (#1394 child 1).
 *
 * Thin wrapper over scope-manifest-core that supplies MCP-specific identity
 * (connector DID, channel `mcp`, scope descriptors, filename). All generic DB
 * logic, consent-grant syncing, and publish orchestration live in the core
 * module to avoid duplication.
 *
 * Unlike OAuth connectors (GitHub, QuickBooks), the MCP connector is
 * credential-free (native): enabling it is purely a matter of toggling scopes
 * in a signed scope-manifest asset. No OAuth App config, no token — the owner
 * just POSTs their desired scopes.
 *
 * Scope release tiers are DERIVED from the declarative vocabulary (#1253) via
 * the #1196 consent 2×2 — see `packages/auth/src/scope-vocabulary.ts`. To add a
 * scope to this connector, add one entry there; this module needs no edit.
 *
 * Refs: #1394 (this epic) · #1253 (vocabulary derivation) · #1222 (MCP grant
 *       back-port) · #1209 (channel-links) · #1207 (projection reactor) ·
 *       scope-manifest-core (shared implementation)
 */
import {
  buildConnectorManifestContent,
  findConnectorManifestAsset,
  readActiveConnectorScopes,
  syncConnectorConsentGrants,
  publishConnectorScopeManifest,
  type Asset,
} from '@/src/lib/kernel/scope-manifest-core';
import {
  connectorScopeDescriptors,
  validScopesForConnector,
  requiresConsentRow,
} from '@/src/lib/kernel/scope-projections';
import { MCP_CONNECTOR_DID, MCP_CHANNEL } from './oauth-config';

// ── Scope registry (derived — #1253) ────────────────────────────────────────

const CONNECTOR = 'mcp' as const;

export const MCP_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_MCP_SCOPES = validScopesForConnector(CONNECTOR);

// ── Public API (delegates to core) ────────────────────────────────────────────

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    MCP_CONNECTOR_DID, MCP_CHANNEL, MCP_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findMcpManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, MCP_CONNECTOR_DID);
}

export function readActiveMcpScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, MCP_CHANNEL, MCP_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, MCP_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishMcpScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: MCP_CONNECTOR_DID, channel: MCP_CHANNEL,
    filename: 'mcp-scope-manifest.md', scopeDescriptors: MCP_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}
