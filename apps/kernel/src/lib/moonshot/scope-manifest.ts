/**
 * Moonshot connector scope-manifest publisher (#1930).
 *
 * Thin wrapper over scope-manifest-core that supplies Moonshot-specific
 * identity (connector DID, channel, scope descriptors, filename). All
 * generic DB logic, consent-grant syncing, and publish orchestration live in
 * the core module.
 *
 * Scope release tiers are DERIVED from the declarative vocabulary (#1253) via
 * the #1196 consent 2×2 — see `packages/auth/src/scope-vocabulary.ts`. To add
 * a scope to this connector, add one entry there; this module needs no edit.
 *
 * `moonshot:infer` is `{ disclosesOthers: false, sensitive: true }`, so the
 * 2×2 derives `owner-only`: the owner's own sealed API key is spent on every
 * call and is never released to a third party.
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
import { MOONSHOT_CONNECTOR_DID, MOONSHOT_CHANNEL } from './connector';

// Re-exported so a connector route needs only this module. `export … from`
// keeps these pure re-exports rather than local bindings that could drift from
// the grant-aware definitions in ./connector (#1774).
export { moonshotKeySealed, moonshotKeyPending } from './connector';

// ── Scope registry (derived — #1253) ────────────────────────────────────────

const CONNECTOR = 'moonshot' as const;

export const MOONSHOT_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_MOONSHOT_SCOPES = validScopesForConnector(CONNECTOR);

// ── Public API (delegates to core) ─────────────────────────────────────────────

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    MOONSHOT_CONNECTOR_DID, MOONSHOT_CHANNEL, MOONSHOT_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findMoonshotManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, MOONSHOT_CONNECTOR_DID);
}

export function readActiveMoonshotScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, MOONSHOT_CHANNEL, MOONSHOT_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, MOONSHOT_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishMoonshotScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: MOONSHOT_CONNECTOR_DID, channel: MOONSHOT_CHANNEL,
    filename: 'moonshot-scope-manifest.md', scopeDescriptors: MOONSHOT_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}
