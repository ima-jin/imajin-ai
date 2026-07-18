/**
 * Discord connector scope-manifest publisher (#1355).
 *
 * Thin wrapper over scope-manifest-core that supplies Discord-specific
 * identity (connector DID, channel, scope descriptors, filenames). All
 * generic DB logic, consent-grant syncing, and publish orchestration live
 * in the core module to avoid duplication across connectors.
 *
 * Scope release tiers (#1196 consent 2×2):
 *   discord:post → on-consent (touches shared channel, visible to others)
 *   discord:read → on-consent (reads others' messages)
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
import { DISCORD_CONNECTOR_DID, vaultField } from './connector';
import { vaultFieldExists } from '@/src/lib/vault';

// ── Scope registry ──────────────────────────────────────────────────────────────

/** Discord connector scopes with #1196 release classifications. */
export const DISCORD_SCOPE_DESCRIPTORS: Readonly<Record<string, ConnectorScopeDescriptor>> = {
  'discord:post': {
    verb: 'post', surface: 'channels',
    label: 'Post messages to Discord channels',
    release: { discloses_others: true, sensitive: false, viewer: DISCORD_CONNECTOR_DID },
  },
  'discord:read': {
    verb: 'read', surface: 'channels',
    label: 'Read messages from Discord channels',
    release: { discloses_others: true, sensitive: false, viewer: DISCORD_CONNECTOR_DID },
  },
};

export const VALID_DISCORD_SCOPES = Object.keys(DISCORD_SCOPE_DESCRIPTORS) as Array<
  keyof typeof DISCORD_SCOPE_DESCRIPTORS
>;

const MANIFEST_CHANNEL = 'discord';

// Both Discord scopes are on-consent (discloses_others: true, no sensitive flag).
function discordScopeReleaseClass(_scopeName: string): 'on-consent' {
  return 'on-consent';
}

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
    (s) => discordScopeReleaseClass(s) === 'on-consent',
  );
}

export function publishDiscordScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: DISCORD_CONNECTOR_DID, channel: MANIFEST_CHANNEL,
    filename: 'discord-scope-manifest.md', scopeDescriptors: DISCORD_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => discordScopeReleaseClass(s) === 'on-consent',
  });
}

/** Check whether a Discord Bot Token is sealed for ownerDid (no crypto, no value returned). */
export function discordTokenSealed(ownerDid: string): Promise<boolean> {
  return vaultFieldExists(vaultField(ownerDid));
}
