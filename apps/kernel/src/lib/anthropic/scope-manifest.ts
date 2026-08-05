/**
 * Anthropic connector scope-manifest publisher (#1621).
 *
 * Thin wrapper over scope-manifest-core that supplies Anthropic-specific
 * identity (connector DID, channel, scope descriptors, filename). All generic
 * DB logic, consent-grant syncing, and publish orchestration live in the core
 * module to avoid duplication across connectors.
 *
 * Scope release tiers are DERIVED from the declarative vocabulary (#1253) via
 * the #1196 consent 2×2 — see `packages/auth/src/scope-vocabulary.ts`. To add a
 * scope to this connector, add one entry there; this module needs no edit.
 *
 * `anthropic:infer` is `{ disclosesOthers: false, sensitive: true }`, so the 2×2
 * derives `owner-only`: the owner's own sealed API key is consumed on every call
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
import { ANTHROPIC_CONNECTOR_DID, vaultField, anthropicKeyPending } from './connector';
import { vaultFieldExists } from '@/src/lib/vault';

export { anthropicKeyPending };

// ── Scope registry (derived — #1253) ────────────────────────────────────────

const CONNECTOR = 'anthropic' as const;

export const ANTHROPIC_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_ANTHROPIC_SCOPES = validScopesForConnector(CONNECTOR);

const MANIFEST_CHANNEL = 'anthropic';

// ── Public API (delegates to core) ─────────────────────────────────────────────

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    ANTHROPIC_CONNECTOR_DID, MANIFEST_CHANNEL, ANTHROPIC_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findAnthropicManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, ANTHROPIC_CONNECTOR_DID);
}

export function readActiveAnthropicScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, MANIFEST_CHANNEL, ANTHROPIC_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, ANTHROPIC_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishAnthropicScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: ANTHROPIC_CONNECTOR_DID, channel: MANIFEST_CHANNEL,
    filename: 'anthropic-scope-manifest.md', scopeDescriptors: ANTHROPIC_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}

/** Check whether an Anthropic API key is sealed for ownerDid (no crypto, no value returned). */
export function anthropicKeySealed(ownerDid: string): Promise<boolean> {
  return vaultFieldExists(vaultField(ownerDid));
}
