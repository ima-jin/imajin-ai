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
 * Scope release tiers (from the #1196 consent 2×2 / mcp-scope-manifest.md fixture):
 *   media:read       → silent      (materialises immediately on publish)
 *   media:write      → on-consent  (tightened; connector needs explicit consent)
 *   media:share      → on-consent  (touches others — crosses sovereignty boundary)
 *   connections:read → silent      (materialises immediately on publish)
 *
 * `messages:read` / `messages:write` (#1393) will be added here when that
 * issue lands; the registry entry is wired at that point too.
 *
 * Refs: #1394 (this epic) · #1222 (MCP grant back-port) · #1209 (channel-links) ·
 *       #1207 (projection reactor) · scope-manifest-core (shared implementation)
 */
import {
  buildConnectorManifestContent,
  findConnectorManifestAsset,
  readActiveConnectorScopes,
  syncConnectorConsentGrants,
  publishConnectorScopeManifest,
  type ConnectorScopeDescriptor,
  type Asset,
} from '@/src/lib/kernel/scope-manifest-core';
import { MCP_CONNECTOR_DID, MCP_CHANNEL } from './oauth-config';

// ── Scope registry ─────────────────────────────────────────────────────────────

/**
 * All four MCP connector scopes, sourced from the mcp-scope-manifest.md fixture
 * and the #1196 consent 2×2.
 */
export const MCP_SCOPE_DESCRIPTORS: Readonly<Record<string, ConnectorScopeDescriptor>> = {
  'media:read': {
    verb: 'read', surface: 'media',
    label: 'Read your media assets',
    release: { discloses_others: false, sensitive: false },
    // Derived tier: silent → materialises immediately on publish.
  },
  'media:write': {
    verb: 'write', surface: 'media',
    label: 'Create and update your media assets',
    release: { discloses_others: false, sensitive: false, release: 'on-consent', viewer: MCP_CONNECTOR_DID },
  },
  'media:share': {
    verb: 'write', surface: 'media-access',
    label: "Grant or revoke other people's access to your assets",
    release: { discloses_others: true, sensitive: false, viewer: MCP_CONNECTOR_DID },
    // Derived tier: on-consent (discloses_others = true).
  },
  'connections:read': {
    verb: 'read', surface: 'connections',
    label: 'Read your trust-graph connections',
    release: { discloses_others: false, sensitive: false },
    // Derived tier: silent → materialises immediately on publish.
  },
};

export const VALID_MCP_SCOPES = Object.keys(MCP_SCOPE_DESCRIPTORS) as Array<
  keyof typeof MCP_SCOPE_DESCRIPTORS
>;

function mcpScopeReleaseClass(scopeName: string): 'silent' | 'on-consent' | 'owner-only' | 'never' {
  const desc = MCP_SCOPE_DESCRIPTORS[scopeName];
  if (!desc) return 'never';
  const r = desc.release;
  if (r.release) return r.release;
  if (!r.discloses_others && !r.sensitive) return 'silent';
  if (r.discloses_others && !r.sensitive) return 'on-consent';
  if (!r.discloses_others && r.sensitive) return 'owner-only';
  return 'never';
}

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
    (s) => mcpScopeReleaseClass(s) === 'on-consent',
  );
}

export function publishMcpScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: MCP_CONNECTOR_DID, channel: MCP_CHANNEL,
    filename: 'mcp-scope-manifest.md', scopeDescriptors: MCP_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => mcpScopeReleaseClass(s) === 'on-consent',
  });
}
