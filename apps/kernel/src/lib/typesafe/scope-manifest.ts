/**
 * TypeSafe.ai connector scope-manifest publisher (#2197).
 *
 * Thin wrapper over scope-manifest-core that supplies TypeSafe-specific
 * identity (connector DID, channel, scope descriptors, filename). All
 * generic DB logic, consent-grant syncing, and publish orchestration live in
 * the core module — same shape as every other token-paste connector's
 * scope-manifest wrapper (see `../openrouter/scope-manifest.ts`).
 *
 * Scope release tiers are DERIVED from the declarative vocabulary (#1253) via
 * the #1196 consent 2×2 — see `packages/auth/src/scope-vocabulary.ts`. To add
 * a scope to this connector, add one entry there; this module needs no edit.
 *
 * `typesafe:decide` is `{ disclosesOthers: false, sensitive: false }`
 * (SELF_ONLY, per the issue's design revision — matching `quickbooks:read`),
 * so the 2×2 derives `silent`: it materialises on manifest publish without a
 * separate consent event.
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
import { TYPESAFE_CONNECTOR_DID, TYPESAFE_CHANNEL } from './connector';

// Re-exported so a connector route needs only this module. `export … from`
// keeps these pure re-exports rather than local bindings that could drift from
// the grant-aware definitions in ./connector (#1774).
export { typesafeKeySealed, typesafeKeyPending } from './connector';

// ── Scope registry (derived — #1253) ────────────────────────────────────────

const CONNECTOR = 'typesafe' as const;

export const TYPESAFE_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_TYPESAFE_SCOPES = validScopesForConnector(CONNECTOR);

// ── Public API (delegates to core) ─────────────────────────────────────────────

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    TYPESAFE_CONNECTOR_DID, TYPESAFE_CHANNEL, TYPESAFE_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findTypesafeManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, TYPESAFE_CONNECTOR_DID);
}

export function readActiveTypesafeScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, TYPESAFE_CHANNEL, TYPESAFE_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, TYPESAFE_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishTypesafeScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: TYPESAFE_CONNECTOR_DID, channel: TYPESAFE_CHANNEL,
    filename: 'typesafe-scope-manifest.md', scopeDescriptors: TYPESAFE_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}
