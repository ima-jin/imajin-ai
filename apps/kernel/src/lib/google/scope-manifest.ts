/**
 * Google Workspace connector scope-manifest publisher (#2144).
 *
 * Thin wrapper over scope-manifest-core that supplies Google-specific identity
 * (connector DID, channel, scope descriptors, filename). All generic DB logic,
 * consent-grant syncing, and publish orchestration live in the core module —
 * modelled directly on `gcp/scope-manifest.ts`.
 *
 * Scopes are DERIVED from the declarative vocabulary (#1253) via the #1196
 * consent 2×2 — see `packages/auth/src/scope-vocabulary.ts`. To add a scope to
 * this connector, add one entry there; this module needs no edit.
 *
 * All six v1 scopes are `{ disclosesOthers: false, sensitive: true }`, so the
 * 2×2 derives `owner-only`: the owner's own sealed refresh token is consumed
 * on every call and is never released to a third party.
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
import { GOOGLE_CONNECTOR_DID } from './constants';

const CONNECTOR = 'google' as const;

export const GOOGLE_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_GOOGLE_SCOPES = validScopesForConnector(CONNECTOR);

const MANIFEST_CHANNEL = 'google';

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    GOOGLE_CONNECTOR_DID, MANIFEST_CHANNEL, GOOGLE_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findGoogleManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, GOOGLE_CONNECTOR_DID);
}

export function readActiveGoogleScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, MANIFEST_CHANNEL, GOOGLE_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, GOOGLE_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishGoogleScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: GOOGLE_CONNECTOR_DID, channel: MANIFEST_CHANNEL,
    filename: 'google-scope-manifest.md', scopeDescriptors: GOOGLE_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}
