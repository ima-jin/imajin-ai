/**
 * Z.ai connector scope-manifest publisher (#1931).
 *
 * Thin wrapper over scope-manifest-core that supplies Z.ai-specific identity
 * (connector DID, channel, scope descriptors, filename). All generic DB
 * logic, consent-grant syncing, and publish orchestration live in the core
 * module.
 *
 * Scope release tiers are DERIVED from the declarative vocabulary (#1253) via
 * the #1196 consent 2×2 — see `packages/auth/src/scope-vocabulary.ts`. To add
 * a scope to this connector, add one entry there; this module needs no edit.
 *
 * `zai:infer` is `{ disclosesOthers: false, sensitive: true }`, so the 2×2
 * derives `owner-only`: the owner's own sealed API key is spent on every call
 * and is never released to a third party.
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
import { ZAI_CONNECTOR_DID, ZAI_CHANNEL } from './connector';

// Re-exported so a connector route needs only this module. `export … from`
// keeps these pure re-exports rather than local bindings that could drift from
// the grant-aware definitions in ./connector (#1774).
export { zaiKeySealed, zaiKeyPending } from './connector';

// ── Scope registry (derived — #1253) ────────────────────────────────────────

const CONNECTOR = 'zai' as const;

export const ZAI_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_ZAI_SCOPES = validScopesForConnector(CONNECTOR);

// ── Public API (delegates to core) ─────────────────────────────────────────────

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    ZAI_CONNECTOR_DID, ZAI_CHANNEL, ZAI_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findZaiManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, ZAI_CONNECTOR_DID);
}

export function readActiveZaiScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, ZAI_CHANNEL, ZAI_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, ZAI_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishZaiScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: ZAI_CONNECTOR_DID, channel: ZAI_CHANNEL,
    filename: 'zai-scope-manifest.md', scopeDescriptors: ZAI_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}
