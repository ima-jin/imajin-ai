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
