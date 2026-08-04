/**
 * Discord connector scope-manifest publisher (#1355).
 *
 * Thin wrapper over scope-manifest-core that supplies Discord-specific
 * identity (connector DID, channel, scope descriptors, filenames). All
 * generic DB logic, consent-grant syncing, and publish orchestration live
 * in the core module to avoid duplication across connectors.
 *
 * Scope release tiers are DERIVED from the declarative vocabulary (#1253) via
 * the #1196 consent 2×2 — see `packages/auth/src/scope-vocabulary.ts`. To add a
 * scope to this connector, add one entry there; this module needs no edit.
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
import { DISCORD_CONNECTOR_DID, vaultField } from './connector';
import { vaultFieldExists, vaultFieldStatus } from '@/src/lib/vault';

// ── Scope registry (derived — #1253) ────────────────────────────────────────

const CONNECTOR = 'discord' as const;

export const DISCORD_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_DISCORD_SCOPES = validScopesForConnector(CONNECTOR);

const MANIFEST_CHANNEL = 'discord';

// ── Public API (delegates to core) ─────────────────────────────────────────────

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    DISCORD_CONNECTOR_DID, MANIFEST_CHANNEL, DISCORD_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findDiscordManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, DISCORD_CONNECTOR_DID);
}

export function readActiveDiscordScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, MANIFEST_CHANNEL, DISCORD_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, DISCORD_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishDiscordScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: DISCORD_CONNECTOR_DID, channel: MANIFEST_CHANNEL,
    filename: 'discord-scope-manifest.md', scopeDescriptors: DISCORD_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}

/** Check whether a Discord Bot Token is sealed for ownerDid (no crypto, no value returned). */
export function discordTokenSealed(ownerDid: string): Promise<boolean> {
  return vaultFieldExists(vaultField(ownerDid));
}

/**
 * Check whether a Discord Bot Token is sealed but awaiting owner grant approval
 * (Tier 1, no active delegation grant yet). Distinct from `discordTokenSealed`
 * so the scope-manifest surface can render "waiting for owner approval" instead
 * of "not connected" — `discordTokenSealed` reports `false` for this state
 * (see field-status.ts).
 */
export async function discordCredentialPending(ownerDid: string): Promise<boolean> {
  return (await vaultFieldStatus(vaultField(ownerDid))) === 'pending-grant';
}
