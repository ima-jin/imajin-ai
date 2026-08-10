/**
 * Gemini connector scope-manifest publisher (#1432).
 *
 * Thin wrapper over scope-manifest-core that supplies Gemini-specific
 * identity (connector DID, channel, scope descriptors, filenames). All
 * generic DB logic, consent-grant syncing, and publish orchestration live
 * in the core module to avoid duplication across connectors.
 *
 * Scope release tiers are DERIVED from the declarative vocabulary (#1253) via
 * the #1196 consent 2×2 — see `packages/auth/src/scope-vocabulary.ts`. To add a
 * scope to this connector, add one entry there; this module needs no edit.
 *
 * `gemini:infer` is `{ disclosesOthers: false, sensitive: true }`, so the 2×2
 * derives `owner-only`: the owner's own sealed API key is consumed on every
 * call and is never released to a third party. This module previously forced
 * `on-consent` with a hardcoded stub, contradicting its own descriptor (#1253).
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
import { GEMINI_CONNECTOR_DID, geminiKeySealed, geminiKeyPending } from './connector';

// Re-exported so a connector route needs only this module. `export … from`
// keeps these pure re-exports rather than local bindings that could drift
// from the corrected, grant-aware definitions in ./connector (#1774 — a local
// `vaultFieldExists`-based redefinition here used to shadow the fix #1724
// made in ./connector, so a disconnected key kept reporting `keySealed: true`
// forever on this route specifically).
export { geminiKeySealed, geminiKeyPending };

// ── Scope registry (derived — #1253) ────────────────────────────────────────

const CONNECTOR = 'gemini' as const;

export const GEMINI_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_GEMINI_SCOPES = validScopesForConnector(CONNECTOR);

const MANIFEST_CHANNEL = 'gemini';

// ── Public API (delegates to core) ─────────────────────────────────────────────

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    GEMINI_CONNECTOR_DID, MANIFEST_CHANNEL, GEMINI_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findGeminiManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, GEMINI_CONNECTOR_DID);
}

export function readActiveGeminiScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, MANIFEST_CHANNEL, GEMINI_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, GEMINI_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishGeminiScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: GEMINI_CONNECTOR_DID, channel: MANIFEST_CHANNEL,
    filename: 'gemini-scope-manifest.md', scopeDescriptors: GEMINI_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}
