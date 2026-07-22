import { describe, it, expect, vi } from 'vitest';

// ─── MCP scope-manifest wrapper tests ────────────────────────────────────────
//
// Tests the MCP-specific layer: descriptor values, constants, and that the
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

vi.mock('../oauth-config', () => ({
  MCP_CONNECTOR_DID: 'did:imajin:mcp-connector',
  MCP_CHANNEL: 'mcp',
}));

import {
  buildManifestContent,
  findMcpManifestAsset,
  readActiveMcpScopes,
  syncConsentGrants,
  publishMcpScopeManifest,
  VALID_MCP_SCOPES,
  MCP_SCOPE_DESCRIPTORS,
} from '../scope-manifest';

const MCP_DID = 'did:imajin:mcp-connector';

// ── Descriptor / constant tests ───────────────────────────────────────────────

describe('MCP_SCOPE_DESCRIPTORS', () => {
  it('defines all four MCP scopes', () => {
    expect(new Set(VALID_MCP_SCOPES)).toEqual(
      new Set(['media:read', 'media:write', 'media:share', 'connections:read']),
    );
  });

  it('media:read is silent (no release override, discloses_others: false)', () => {
    const r = MCP_SCOPE_DESCRIPTORS['media:read'].release;
    expect(r.discloses_others).toBe(false);
    expect(r.sensitive).toBe(false);
    expect(r.release).toBeUndefined();
  });

  it('media:write is on-consent (explicit release override)', () => {
    const r = MCP_SCOPE_DESCRIPTORS['media:write'].release;
    expect(r.release).toBe('on-consent');
    expect(r.viewer).toBe(MCP_DID);
  });

  it('media:share is on-consent (derived from discloses_others: true)', () => {
    const r = MCP_SCOPE_DESCRIPTORS['media:share'].release;
    expect(r.discloses_others).toBe(true);
    expect(r.sensitive).toBe(false);
    expect(r.viewer).toBe(MCP_DID);
    // No explicit release override — tier is derived from 2×2
    expect(r.release).toBeUndefined();
  });

  it('connections:read is silent (no release override, discloses_others: false)', () => {
    const r = MCP_SCOPE_DESCRIPTORS['connections:read'].release;
    expect(r.discloses_others).toBe(false);
    expect(r.sensitive).toBe(false);
    expect(r.release).toBeUndefined();
  });
});

// ── Delegation tests ──────────────────────────────────────────────────────────

describe('buildManifestContent', () => {
  it('calls buildConnectorManifestContent with MCP DID, channel, descriptors', () => {
    buildManifestContent(['media:read']);
    expect(mockBuild).toHaveBeenCalledWith(
      MCP_DID, 'mcp', MCP_SCOPE_DESCRIPTORS, ['media:read'],
    );
  });
});

describe('findMcpManifestAsset', () => {
  it('calls findConnectorManifestAsset with ownerDid and MCP DID', async () => {
    await findMcpManifestAsset('did:owner');
    expect(mockFind).toHaveBeenCalledWith('did:owner', MCP_DID);
  });
});

describe('readActiveMcpScopes', () => {
  it('calls readActiveConnectorScopes with mcp channel and MCP DID', async () => {
    await readActiveMcpScopes('did:owner');
    expect(mockReadActive).toHaveBeenCalledWith('did:owner', 'mcp', MCP_DID);
  });
});

describe('syncConsentGrants', () => {
  it('passes on-consent predicate to syncConnectorConsentGrants', async () => {
    await syncConsentGrants('did:owner', 'asset_x', ['media:write', 'media:share']);
    expect(mockSync).toHaveBeenCalledOnce();
    const [, connDid, , , isOnConsent] = mockSync.mock.calls[0];
    expect(connDid).toBe(MCP_DID);
    // on-consent scopes
    expect(isOnConsent('media:write')).toBe(true);
    expect(isOnConsent('media:share')).toBe(true);
    // silent scopes
    expect(isOnConsent('media:read')).toBe(false);
    expect(isOnConsent('connections:read')).toBe(false);
    // unknown scope → never tier
    expect(isOnConsent('unknown:scope')).toBe(false);
  });
});

describe('publishMcpScopeManifest', () => {
  it('calls publishConnectorScopeManifest with correct MCP opts', async () => {
    await publishMcpScopeManifest('did:owner', ['media:read', 'connections:read']);
    expect(mockPublish).toHaveBeenCalledOnce();
    const opts = mockPublish.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.connectorDid).toBe(MCP_DID);
    expect(opts.channel).toBe('mcp');
    expect(opts.filename).toBe('mcp-scope-manifest.md');
    expect(opts.scopeDescriptors).toBe(MCP_SCOPE_DESCRIPTORS);
    expect(opts.scopes).toEqual(['media:read', 'connections:read']);
  });

  it('isOnConsent predicate correctly classifies scopes', async () => {
    await publishMcpScopeManifest('did:owner', ['media:write']);
    const opts = mockPublish.mock.calls[0][0] as Record<string, unknown>;
    const isOnConsent = opts.isOnConsent as (s: string) => boolean;
    expect(isOnConsent('media:write')).toBe(true);
    expect(isOnConsent('media:share')).toBe(true);
    expect(isOnConsent('media:read')).toBe(false);
    expect(isOnConsent('connections:read')).toBe(false);
  });
});
