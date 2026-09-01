/**
 * OpenAI connector scope-manifest publisher (#1927).
 *
 * Thin wrapper over scope-manifest-core that supplies OpenAI-specific
 * identity (connector DID, channel, scope descriptors, filename). All
 * generic DB logic, consent-grant syncing, and publish orchestration live in
 * the core module.
 *
 * Scope release tiers are DERIVED from the declarative vocabulary (#1253) via
 * the #1196 consent 2×2 — see `packages/auth/src/scope-vocabulary.ts`. To add
 * a scope to this connector, add one entry there; this module needs no edit.
 *
 * `openai:infer` is `{ disclosesOthers: false, sensitive: true }`, so the 2×2
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
import { OPENAI_CONNECTOR_DID, OPENAI_CHANNEL } from './connector';

// Re-exported so a connector route needs only this module. `export … from`
// keeps these pure re-exports rather than local bindings that could drift from
// the grant-aware definitions in ./connector (#1774).
export { openaiKeySealed, openaiKeyPending } from './connector';

// ── Scope registry (derived — #1253) ────────────────────────────────────────

const CONNECTOR = 'openai' as const;

export const OPENAI_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_OPENAI_SCOPES = validScopesForConnector(CONNECTOR);

// ── Public API (delegates to core) ─────────────────────────────────────────────

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    OPENAI_CONNECTOR_DID, OPENAI_CHANNEL, OPENAI_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findOpenaiManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, OPENAI_CONNECTOR_DID);
}

export function readActiveOpenaiScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, OPENAI_CHANNEL, OPENAI_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, OPENAI_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishOpenaiScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: OPENAI_CONNECTOR_DID, channel: OPENAI_CHANNEL,
    filename: 'openai-scope-manifest.md', scopeDescriptors: OPENAI_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}
