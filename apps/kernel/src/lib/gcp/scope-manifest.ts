/**
 * Google Cloud connector scope-manifest publisher (#1317).
 *
 * Thin wrapper over scope-manifest-core that supplies GCP-specific identity
 * (connector DID, channel, scope descriptors, filename). All generic DB logic,
 * consent-grant syncing, and publish orchestration live in the core module to
 * avoid duplication across connectors.
 *
 * Scope release tiers are DERIVED from the declarative vocabulary (#1253) via
 * the #1196 consent 2×2 — see `packages/auth/src/scope-vocabulary.ts`. To add a
 * scope to this connector, add one entry there; this module needs no edit. That
 * matters more here than elsewhere: Stage 1 ships three narrow scopes and Stage
 * 2 will want more, and each of those must be one vocabulary row rather than a
 * hand-sync across five lists.
 *
 * All three Stage 1 scopes are `{ disclosesOthers: false, sensitive: true }`, so
 * the 2×2 derives `owner-only`: the owner's own sealed service-account key is
 * consumed on every call and is never released to a third party.
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
import { GCP_CONNECTOR_DID, vaultField, gcpKeyPending } from './connector';
import { vaultFieldExists } from '@/src/lib/vault';

export { gcpKeyPending };

// ── Scope registry (derived — #1253) ────────────────────────────────────────

const CONNECTOR = 'gcp' as const;

export const GCP_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_GCP_SCOPES = validScopesForConnector(CONNECTOR);

const MANIFEST_CHANNEL = 'gcp';

// ── Public API (delegates to core) ─────────────────────────────────────────────

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    GCP_CONNECTOR_DID, MANIFEST_CHANNEL, GCP_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findGcpManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, GCP_CONNECTOR_DID);
}

export function readActiveGcpScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, MANIFEST_CHANNEL, GCP_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, GCP_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishGcpScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: GCP_CONNECTOR_DID, channel: MANIFEST_CHANNEL,
    filename: 'gcp-scope-manifest.md', scopeDescriptors: GCP_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}

/** Check whether a GCP key is sealed for ownerDid (no crypto, no value returned). */
export function gcpKeySealed(ownerDid: string): Promise<boolean> {
  return vaultFieldExists(vaultField(ownerDid));
}
