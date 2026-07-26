/**
 * Gemini connector scope-manifest publisher (#1432).
 *
 * Thin wrapper over scope-manifest-core that supplies Gemini-specific
 * identity (connector DID, channel, scope descriptors, filenames). All
 * generic DB logic, consent-grant syncing, and publish orchestration live
 * in the core module to avoid duplication across connectors.
 *
 * Scope release tiers (#1196 consent 2×2):
 *   gemini:infer → on-consent (user's sealed API key is consumed on each call)
 */
import {
  buildConnectorManifestContent,
  findConnectorManifestAsset,
  readActiveConnectorScopes,
  syncConnectorConsentGrants,
  publishConnectorScopeManifest,
  type ConnectorScopeDescriptor,
  type Asset,
} from '@/src/lib/kernel/scope-manifest-core';
import { GEMINI_CONNECTOR_DID, vaultField } from './connector';
import { vaultFieldExists } from '@/src/lib/vault';

// ── Scope registry ──────────────────────────────────────────────────────────────

/** Gemini connector scopes with #1196 release classifications. */
export const GEMINI_SCOPE_DESCRIPTORS: Readonly<Record<string, ConnectorScopeDescriptor>> = {
  'gemini:infer': {
    verb: 'infer', surface: 'gemini-api',
    label: 'Use your Gemini API key for inference',
    release: { discloses_others: false, sensitive: true, viewer: GEMINI_CONNECTOR_DID },
  },
};

export const VALID_GEMINI_SCOPES = Object.keys(GEMINI_SCOPE_DESCRIPTORS) as Array<
  keyof typeof GEMINI_SCOPE_DESCRIPTORS
>;

const MANIFEST_CHANNEL = 'gemini';

// gemini:infer is on-consent (sensitive: true — user's own API key is consumed).
function geminiScopeReleaseClass(_scopeName: string): 'on-consent' {
  return 'on-consent';
}

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
    (s) => geminiScopeReleaseClass(s) === 'on-consent',
  );
}

export function publishGeminiScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: GEMINI_CONNECTOR_DID, channel: MANIFEST_CHANNEL,
    filename: 'gemini-scope-manifest.md', scopeDescriptors: GEMINI_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => geminiScopeReleaseClass(s) === 'on-consent',
  });
}

/** Check whether a Gemini API key is sealed for ownerDid (no crypto, no value returned). */
export function geminiKeySealed(ownerDid: string): Promise<boolean> {
  return vaultFieldExists(vaultField(ownerDid));
}
