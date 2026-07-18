import { describe, it, expect, vi } from 'vitest';

// ─── Discord scope-manifest wrapper tests ─────────────────────────────────────
//
// Tests the Discord-specific layer: descriptor values, constants, and that the
// wrapper functions delegate to scope-manifest-core with the right parameters.
// The core logic (DB queries, consent grant sync, publish orchestration) is
// tested in kernel/__tests__/scope-manifest-core.test.ts.

const { mockBuild, mockFind, mockReadActive, mockSync, mockPublish } = vi.hoisted(() => ({
  mockBuild: vi.fn(() => 'yaml-content'),
  mockFind: vi.fn(async () => null),
  mockReadActive: vi.fn(async () => []),
  mockSync: vi.fn(async () => undefined),
  mockPublish: vi.fn(async () => 'asset_yyy'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => ({
  buildConnectorManifestContent: mockBuild,
  findConnectorManifestAsset: mockFind,
  readActiveConnectorScopes: mockReadActive,
  syncConnectorConsentGrants: mockSync,
  publishConnectorScopeManifest: mockPublish,
}));

vi.mock('../connector', () => ({
  DISCORD_CONNECTOR_DID: 'did:imajin:discord-connector',
  vaultField: (did: string) => `discord-bot-token:${did}`,
}));

vi.mock('@/src/lib/vault', () => ({ vaultFieldExists: vi.fn().mockResolvedValue(false) }));

import {
  buildManifestContent,
  findDiscordManifestAsset,
  readActiveDiscordScopes,
  syncConsentGrants,
  publishDiscordScopeManifest,
  discordTokenSealed,
  VALID_DISCORD_SCOPES,
  DISCORD_SCOPE_DESCRIPTORS,
} from '../scope-manifest';
import { DISCORD_CONNECTOR_DID } from '../connector';

// ── Descriptor / constant tests ───────────────────────────────────────────────

describe('DISCORD_SCOPE_DESCRIPTORS', () => {
  it('defines discord:post and discord:read', () => {
    expect(new Set(VALID_DISCORD_SCOPES)).toEqual(new Set(['discord:post', 'discord:read']));
  });

  it('both scopes have discloses_others: true (on-consent tier)', () => {
    for (const scope of VALID_DISCORD_SCOPES) {
      expect(DISCORD_SCOPE_DESCRIPTORS[scope].release.discloses_others).toBe(true);
      expect(DISCORD_SCOPE_DESCRIPTORS[scope].release.sensitive).toBe(false);
    }
  });

  it('both scopes have viewer set to the Discord connector DID', () => {
    for (const scope of VALID_DISCORD_SCOPES) {
      expect(DISCORD_SCOPE_DESCRIPTORS[scope].release.viewer).toBe(DISCORD_CONNECTOR_DID);
    }
  });
});

// ── Delegation tests ──────────────────────────────────────────────────────────

describe('buildManifestContent', () => {
  it('calls buildConnectorManifestContent with Discord DID, channel, descriptors', () => {
    buildManifestContent(['discord:post']);
    expect(mockBuild).toHaveBeenCalledWith(
      DISCORD_CONNECTOR_DID, 'discord', DISCORD_SCOPE_DESCRIPTORS, ['discord:post'],
    );
  });
});

describe('findDiscordManifestAsset', () => {
  it('calls findConnectorManifestAsset with Discord DID', async () => {
    await findDiscordManifestAsset('did:owner');
    expect(mockFind).toHaveBeenCalledWith('did:owner', DISCORD_CONNECTOR_DID);
  });
});

describe('readActiveDiscordScopes', () => {
  it('calls readActiveConnectorScopes with discord channel and Discord DID', async () => {
    await readActiveDiscordScopes('did:owner');
    expect(mockReadActive).toHaveBeenCalledWith('did:owner', 'discord', DISCORD_CONNECTOR_DID);
  });
});

describe('syncConsentGrants', () => {
  it('passes on-consent predicate to syncConnectorConsentGrants (all Discord scopes are on-consent)', async () => {
    await syncConsentGrants('did:owner', 'asset_x', ['discord:post']);
    expect(mockSync).toHaveBeenCalledOnce();
    const [, connDid, , , isOnConsent] = mockSync.mock.calls[0];
    expect(connDid).toBe(DISCORD_CONNECTOR_DID);
    expect(isOnConsent('discord:post')).toBe(true);
    expect(isOnConsent('discord:read')).toBe(true);
  });
});

describe('publishDiscordScopeManifest', () => {
  it('calls publishConnectorScopeManifest with correct Discord opts', async () => {
    await publishDiscordScopeManifest('did:owner', ['discord:post']);
    expect(mockPublish).toHaveBeenCalledOnce();
    const opts = mockPublish.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.connectorDid).toBe(DISCORD_CONNECTOR_DID);
    expect(opts.channel).toBe('discord');
    expect(opts.filename).toBe('discord-scope-manifest.md');
    expect(opts.scopeDescriptors).toBe(DISCORD_SCOPE_DESCRIPTORS);
  });
});

describe('discordTokenSealed', () => {
  it('returns false when no token is sealed', async () => {
    expect(await discordTokenSealed('did:owner')).toBe(false);
  });
});
