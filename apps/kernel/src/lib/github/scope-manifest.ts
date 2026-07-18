/**
 * GitHub connector scope-manifest publisher (#1352).
 *
 * Thin wrapper over scope-manifest-core that supplies GitHub-specific
 * identity (connector DID, channel, scope descriptors, filenames). All
 * generic DB logic, consent-grant syncing, and publish orchestration live
 * in the core module to avoid duplication across connectors.
 *
 * Scope release tiers (#1196 consent 2×2):
 *   github:read    → silent    (materialises on publish)
 *   github:write   → on-consent (tightened; connector needs explicit consent)
 *   github:org     → on-consent (touches others)
 *   github:actions → never     (structural drop)
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
import { GITHUB_CONNECTOR_DID } from './connector';

// ── Scope registry ──────────────────────────────────────────────────────────────

/** All four GitHub connector scopes, mirroring the #1203 fixture. */
export const GITHUB_SCOPE_DESCRIPTORS: Readonly<Record<string, ConnectorScopeDescriptor>> = {
  'github:read': {
    verb: 'read', surface: 'repos',
    label: 'Read your own repos, issues and PRs',
    release: { discloses_others: false, sensitive: false },
  },
  'github:write': {
    verb: 'write', surface: 'issues',
    label: 'Open and comment on issues & PRs on your repos',
    release: { discloses_others: false, sensitive: false, release: 'on-consent', viewer: GITHUB_CONNECTOR_DID },
  },
  'github:org': {
    verb: 'write', surface: 'org',
    label: 'Act on repos owned by an org or other people',
    release: { discloses_others: true, sensitive: false, viewer: GITHUB_CONNECTOR_DID },
  },
  'github:actions': {
    verb: 'execute', surface: 'actions',
    label: 'Trigger Actions / deploy / spend CI minutes',
    release: { discloses_others: true, sensitive: true },
  },
};

export const VALID_GITHUB_SCOPES = Object.keys(GITHUB_SCOPE_DESCRIPTORS) as Array<
  keyof typeof GITHUB_SCOPE_DESCRIPTORS
>;

const MANIFEST_CHANNEL = 'github';

function githubScopeReleaseClass(scopeName: string): 'silent' | 'on-consent' | 'owner-only' | 'never' {
  const desc = GITHUB_SCOPE_DESCRIPTORS[scopeName];
  if (!desc) return 'never';
  const r = desc.release;
  if (r.release) return r.release;
  if (!r.discloses_others && !r.sensitive) return 'silent';
  if (r.discloses_others && !r.sensitive) return 'on-consent';
  if (!r.discloses_others && r.sensitive) return 'owner-only';
  return 'never';
}

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
    (s) => githubScopeReleaseClass(s) === 'on-consent',
  );
}

export function publishGitHubScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: GITHUB_CONNECTOR_DID, channel: MANIFEST_CHANNEL,
    filename: 'github-scope-manifest.md', scopeDescriptors: GITHUB_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => githubScopeReleaseClass(s) === 'on-consent',
  });
}
