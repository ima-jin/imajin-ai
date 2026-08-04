/**
 * Warp connector scope-manifest publisher (#1428).
 *
 * Thin wrapper over scope-manifest-core supplying Warp-specific identity
 * (connector DID, channel, scope descriptors, filename). All generic DB logic,
 * consent-grant syncing, and publish orchestration live in the core module.
 *
 * Scope release tiers are DERIVED from the declarative vocabulary (#1253) via
 * the #1196 consent 2×2 — see `packages/auth/src/scope-vocabulary.ts`. To add a
 * scope to this connector, add one entry there; this module needs no edit.
 *
 * `warp:dispatch` is `{ disclosesOthers: false, sensitive: true }`, so the 2×2
 * derives `owner-only`: the owner's own sealed Warp Agent key is consumed on
 * every dispatch and is never released to a third party.
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
import { WARP_CONNECTOR_DID, WARP_CHANNEL } from './connector';

// Re-exported so a connector route needs only this module, mirroring the Gemini
// wrapper. `export … from` keeps it a pure re-export rather than a local binding.
export { warpKeySealed, warpKeyPending } from './connector';

// ── Scope registry (derived — #1253) ────────────────────────────────────────

const CONNECTOR = 'warp' as const;

export const WARP_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_WARP_SCOPES = validScopesForConnector(CONNECTOR);

// ── Public API (delegates to core) ─────────────────────────────────────────────

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    WARP_CONNECTOR_DID, WARP_CHANNEL, WARP_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findWarpManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, WARP_CONNECTOR_DID);
}

export function readActiveWarpScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, WARP_CHANNEL, WARP_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, WARP_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishWarpScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: WARP_CONNECTOR_DID, channel: WARP_CHANNEL,
    filename: 'warp-scope-manifest.md', scopeDescriptors: WARP_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}
