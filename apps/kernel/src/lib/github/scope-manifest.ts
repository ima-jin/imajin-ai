/**
 * GitHub connector scope-manifest publisher (#1352).
 *
 * Thin wrapper over scope-manifest-core that supplies GitHub-specific
 * identity (connector DID, channel, scope descriptors, filenames). All
 * generic DB logic, consent-grant syncing, and publish orchestration live
 * in the core module to avoid duplication across connectors.
 *
 * Scope release tiers are DERIVED from the declarative vocabulary (#1253) via
 * the #1196 consent 2×2 — see `packages/auth/src/scope-vocabulary.ts`. To add a
 * scope to this connector, add one entry there; this module needs no edit.
 */
import {
  buildConnectorManifestContent,
  findConnectorManifestAsset,
  readActiveConnectorScopes,
  syncConnectorConsentGrants,
  publishConnectorScopeManifest,
  countExternalScopeGrantees,
  type Asset,
} from '@/src/lib/kernel/scope-manifest-core';
import {
  connectorScopeDescriptors,
  validScopesForConnector,
  requiresConsentRow,
} from '@/src/lib/kernel/scope-projections';
import { GITHUB_CONNECTOR_DID } from './constants';

// ── Scope registry (derived — #1253) ────────────────────────────────────────

const CONNECTOR = 'github' as const;

export const GITHUB_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_GITHUB_SCOPES = validScopesForConnector(CONNECTOR);

const MANIFEST_CHANNEL = 'github';

// ── Public API (delegates to core) ─────────────────────────────────────────────

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    GITHUB_CONNECTOR_DID, MANIFEST_CHANNEL, GITHUB_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findGitHubManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, GITHUB_CONNECTOR_DID);
}

export function readActiveGitHubScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, MANIFEST_CHANNEL, GITHUB_CONNECTOR_DID);
}

/**
 * Count of distinct external (MCP/OAuth-client) grantees currently holding an
 * active grant of one or more `github:*` scopes (#2308) — never the connector
 * card's own scope-manifest grantee. Powers the card's one-line pointer
 * toward #2288's Grants lane; the grants themselves are never listed here.
 */
export function countExternalGitHubScopeGrantees(ownerDid: string): Promise<number> {
  return countExternalScopeGrantees(ownerDid, MANIFEST_CHANNEL, GITHUB_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, GITHUB_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishGitHubScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: GITHUB_CONNECTOR_DID, channel: MANIFEST_CHANNEL,
    filename: 'github-scope-manifest.md', scopeDescriptors: GITHUB_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}
