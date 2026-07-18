import { describe, it, expect, vi } from 'vitest';

// ─── GitHub scope-manifest wrapper tests ─────────────────────────────────────
//
// Tests the GitHub-specific layer: descriptor values, constants, and that the
// wrapper functions delegate to scope-manifest-core with the right parameters.
// The core logic (DB queries, consent grant sync, publish orchestration) is
// tested in kernel/__tests__/scope-manifest-core.test.ts.

const { mockBuild, mockFind, mockReadActive, mockSync, mockPublish } = vi.hoisted(() => ({
  mockBuild: vi.fn(() => 'yaml-content'),
  mockFind: vi.fn(async () => null),
  mockReadActive: vi.fn(async () => []),
  mockSync: vi.fn(async () => undefined),
  mockPublish: vi.fn(async () => 'asset_xxx'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => ({
  buildConnectorManifestContent: mockBuild,
  findConnectorManifestAsset: mockFind,
  readActiveConnectorScopes: mockReadActive,
  syncConnectorConsentGrants: mockSync,
  publishConnectorScopeManifest: mockPublish,
}));

vi.mock('../connector', () => ({ GITHUB_CONNECTOR_DID: 'did:imajin:github-connector' }));

import {
  buildManifestContent,
  findGitHubManifestAsset,
  readActiveGitHubScopes,
  syncConsentGrants,
  publishGitHubScopeManifest,
  VALID_GITHUB_SCOPES,
  GITHUB_SCOPE_DESCRIPTORS,
} from '../scope-manifest';
import { GITHUB_CONNECTOR_DID } from '../connector';

// ── Descriptor / constant tests ───────────────────────────────────────────────

describe('GITHUB_SCOPE_DESCRIPTORS', () => {
  it('defines all four GitHub scopes', () => {
    expect(new Set(VALID_GITHUB_SCOPES)).toEqual(
      new Set(['github:read', 'github:write', 'github:org', 'github:actions']),
    );
  });

  it('github:read is silent (no release override, discloses_others: false)', () => {
    const r = GITHUB_SCOPE_DESCRIPTORS['github:read'].release;
    expect(r.discloses_others).toBe(false);
    expect(r.sensitive).toBe(false);
    expect(r.release).toBeUndefined();
  });

  it('github:write is on-consent (explicit release override)', () => {
    const r = GITHUB_SCOPE_DESCRIPTORS['github:write'].release;
    expect(r.release).toBe('on-consent');
    expect(r.viewer).toBe(GITHUB_CONNECTOR_DID);
  });

  it('github:actions has discloses_others: true + sensitive: true (never tier)', () => {
    const r = GITHUB_SCOPE_DESCRIPTORS['github:actions'].release;
    expect(r.discloses_others).toBe(true);
    expect(r.sensitive).toBe(true);
  });
});

// ── Delegation tests ──────────────────────────────────────────────────────────

describe('buildManifestContent', () => {
  it('calls buildConnectorManifestContent with GitHub DID, channel, descriptors', () => {
    buildManifestContent(['github:read']);
    expect(mockBuild).toHaveBeenCalledWith(
      GITHUB_CONNECTOR_DID, 'github', GITHUB_SCOPE_DESCRIPTORS, ['github:read'],
    );
  });
});

describe('findGitHubManifestAsset', () => {
  it('calls findConnectorManifestAsset with ownerDid and GitHub DID', async () => {
    await findGitHubManifestAsset('did:owner');
    expect(mockFind).toHaveBeenCalledWith('did:owner', GITHUB_CONNECTOR_DID);
  });
});

describe('readActiveGitHubScopes', () => {
  it('calls readActiveConnectorScopes with github channel and GitHub DID', async () => {
    await readActiveGitHubScopes('did:owner');
    expect(mockReadActive).toHaveBeenCalledWith('did:owner', 'github', GITHUB_CONNECTOR_DID);
  });
});

describe('syncConsentGrants', () => {
  it('passes on-consent predicate to syncConnectorConsentGrants', async () => {
    await syncConsentGrants('did:owner', 'asset_x', ['github:write']);
    expect(mockSync).toHaveBeenCalledOnce();
    const [, connDid, , , isOnConsent] = mockSync.mock.calls[0];
    expect(connDid).toBe(GITHUB_CONNECTOR_DID);
    // github:write is on-consent; github:read is silent
    expect(isOnConsent('github:write')).toBe(true);
    expect(isOnConsent('github:read')).toBe(false);
    expect(isOnConsent('github:actions')).toBe(false);
  });
});

describe('publishGitHubScopeManifest', () => {
  it('calls publishConnectorScopeManifest with correct GitHub opts', async () => {
    await publishGitHubScopeManifest('did:owner', ['github:read']);
    expect(mockPublish).toHaveBeenCalledOnce();
    const opts = mockPublish.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.connectorDid).toBe(GITHUB_CONNECTOR_DID);
    expect(opts.channel).toBe('github');
    expect(opts.filename).toBe('github-scope-manifest.md');
    expect(opts.scopeDescriptors).toBe(GITHUB_SCOPE_DESCRIPTORS);
  });
});
