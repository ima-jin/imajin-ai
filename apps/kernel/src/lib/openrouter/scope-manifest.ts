/**
 * OpenRouter connector scope-manifest publisher (#2188).
 *
 * Thin wrapper over scope-manifest-core that supplies OpenRouter-specific
 * identity (connector DID, channel, scope descriptors, filename). All
 * generic DB logic, consent-grant syncing, and publish orchestration live in
 * the core module.
 *
 * Scope release tiers are DERIVED from the declarative vocabulary (#1253) via
 * the #1196 consent 2×2 — see `packages/auth/src/scope-vocabulary.ts`. To add
 * a scope to this connector, add one entry there; this module needs no edit.
 *
 * `openrouter:infer` is `{ disclosesOthers: false, sensitive: true }`, so the
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
import { OPENROUTER_CONNECTOR_DID, OPENROUTER_CHANNEL } from './connector';

// Re-exported so a connector route needs only this module. `export … from`
// keeps these pure re-exports rather than local bindings that could drift from
// the grant-aware definitions in ./connector (#1774).
export { openrouterKeySealed, openrouterKeyPending } from './connector';

// ── Scope registry (derived — #1253) ────────────────────────────────────────

const CONNECTOR = 'openrouter' as const;

export const OPENROUTER_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_OPENROUTER_SCOPES = validScopesForConnector(CONNECTOR);

// ── Public API (delegates to core) ─────────────────────────────────────────────

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    OPENROUTER_CONNECTOR_DID, OPENROUTER_CHANNEL, OPENROUTER_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findOpenrouterManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, OPENROUTER_CONNECTOR_DID);
}

export function readActiveOpenrouterScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, OPENROUTER_CHANNEL, OPENROUTER_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, OPENROUTER_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishOpenrouterScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: OPENROUTER_CONNECTOR_DID, channel: OPENROUTER_CHANNEL,
    filename: 'openrouter-scope-manifest.md', scopeDescriptors: OPENROUTER_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}
