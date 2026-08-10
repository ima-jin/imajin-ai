import { describe, it, expect, vi } from 'vitest';

// --- QuickBooks scope-manifest wrapper tests (#1356) -------------------------
//
// Tests the QuickBooks-specific layer: descriptor values, release tiers, and
// delegation call shapes. Core logic is tested in
// kernel/__tests__/scope-manifest-core.test.ts.

const { mockBuild, mockFind, mockReadActive, mockSync, mockPublish } = vi.hoisted(() => ({
  mockBuild: vi.fn(() => 'yaml-content'),
  mockFind: vi.fn(async () => null),
  mockReadActive: vi.fn(async () => []),
  mockSync: vi.fn(async () => undefined),
  mockPublish: vi.fn(async () => 'asset_qb'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => ({
  buildConnectorManifestContent: mockBuild,
  findConnectorManifestAsset: mockFind,
  readActiveConnectorScopes: mockReadActive,
  syncConnectorConsentGrants: mockSync,
  publishConnectorScopeManifest: mockPublish,
}));

vi.mock('../connector', () => ({
  QUICKBOOKS_CONNECTOR_DID: 'did:imajin:quickbooks-connector',
  configField: (did: string) => `quickbooks-config:${did}`,
  vaultField: (did: string) => `quickbooks-oauth:${did}`,
}));

const { mockVaultExists, mockVaultStatus, mockGetPlatformDid } = vi.hoisted(() => ({
  mockVaultExists: vi.fn().mockResolvedValue(false),
  mockVaultStatus: vi.fn().mockResolvedValue('absent'),
  mockGetPlatformDid: vi.fn().mockReturnValue(undefined),
}));
vi.mock('@/src/lib/vault', () => ({ vaultFieldExists: mockVaultExists, vaultFieldStatus: mockVaultStatus }));
vi.mock('@/src/lib/kernel/connector-platform-did', () => ({ getPlatformDid: mockGetPlatformDid }));

import {
  buildManifestContent,
  findQuickBooksManifestAsset,
  readActiveQuickBooksScopes,
  syncConsentGrants,
  publishQuickBooksScopeManifest,
  quickbooksConfigSealed,
  quickbooksTokenSealed,
  quickbooksCredentialPending,
  VALID_QUICKBOOKS_SCOPES,
  QUICKBOOKS_SCOPE_DESCRIPTORS,
} from '../scope-manifest';
import { QUICKBOOKS_CONNECTOR_DID } from '../connector';

// -- Descriptor / constant tests ----------------------------------------------

describe('QUICKBOOKS_SCOPE_DESCRIPTORS', () => {
  it('defines quickbooks:read and quickbooks:write', () => {
    expect(new Set(VALID_QUICKBOOKS_SCOPES)).toEqual(
      new Set(['quickbooks:read', 'quickbooks:write']),
    );
  });

  it('quickbooks:read is silent (discloses_others: false, no release override)', () => {
    const r = QUICKBOOKS_SCOPE_DESCRIPTORS['quickbooks:read'].release;
    expect(r.discloses_others).toBe(false);
    expect(r.sensitive).toBe(false);
    expect(r.release).toBeUndefined();
  });

  it('quickbooks:write is on-consent (discloses_others: true, touches customers)', () => {
    const r = QUICKBOOKS_SCOPE_DESCRIPTORS['quickbooks:write'].release;
    expect(r.discloses_others).toBe(true);
    expect(r.sensitive).toBe(false);
    expect(r.viewer).toBe(QUICKBOOKS_CONNECTOR_DID);
  });
});

// -- Delegation tests ---------------------------------------------------------

describe('buildManifestContent', () => {
  it('delegates to buildConnectorManifestContent with QB DID and channel', () => {
    buildManifestContent(['quickbooks:read']);
    expect(mockBuild).toHaveBeenCalledWith(
      QUICKBOOKS_CONNECTOR_DID, 'quickbooks', QUICKBOOKS_SCOPE_DESCRIPTORS, ['quickbooks:read'],
    );
  });
});

describe('findQuickBooksManifestAsset', () => {
  it('delegates to findConnectorManifestAsset with QB DID', async () => {
    await findQuickBooksManifestAsset('did:owner');
    expect(mockFind).toHaveBeenCalledWith('did:owner', QUICKBOOKS_CONNECTOR_DID);
  });
});

describe('readActiveQuickBooksScopes', () => {
  it('delegates with quickbooks channel and QB DID', async () => {
    await readActiveQuickBooksScopes('did:owner');
    expect(mockReadActive).toHaveBeenCalledWith('did:owner', 'quickbooks', QUICKBOOKS_CONNECTOR_DID);
  });
});

describe('syncConsentGrants', () => {
  it('marks quickbooks:write as on-consent and quickbooks:read as silent', async () => {
    await syncConsentGrants('did:owner', 'asset_x', ['quickbooks:write']);
    const [, connDid, , , isOnConsent] = mockSync.mock.calls[0];
    expect(connDid).toBe(QUICKBOOKS_CONNECTOR_DID);
    expect(isOnConsent('quickbooks:write')).toBe(true);
    expect(isOnConsent('quickbooks:read')).toBe(false);
  });
});

describe('publishQuickBooksScopeManifest', () => {
  it('calls publishConnectorScopeManifest with correct QB opts', async () => {
    await publishQuickBooksScopeManifest('did:owner', ['quickbooks:read']);
    const opts = mockPublish.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.connectorDid).toBe(QUICKBOOKS_CONNECTOR_DID);
    expect(opts.channel).toBe('quickbooks');
    expect(opts.filename).toBe('quickbooks-scope-manifest.md');
    expect(opts.scopeDescriptors).toBe(QUICKBOOKS_SCOPE_DESCRIPTORS);
  });
});

// -- Credential status --------------------------------------------------------

describe('quickbooksConfigSealed', () => {
  it('returns false when config not sealed and no platform DID is configured', async () => {
    mockGetPlatformDid.mockReturnValue(undefined);
    mockVaultExists.mockResolvedValueOnce(false);
    expect(await quickbooksConfigSealed('did:owner')).toBe(false);
  });

  it('returns true when the owner\'s own config is sealed', async () => {
    mockVaultExists.mockResolvedValueOnce(true);
    expect(await quickbooksConfigSealed('did:owner')).toBe(true);
  });

  // ── Platform fallback (#1775) ──────────────────────────────────────────────

  it('returns true when the owner has no config but the shared platform DID does', async () => {
    mockGetPlatformDid.mockReturnValue('did:imajin:platform');
    mockVaultExists.mockImplementation(async (field: string) => field === 'quickbooks-config:did:imajin:platform');

    expect(await quickbooksConfigSealed('did:owner')).toBe(true);
  });

  it('returns false when neither the owner nor the platform DID has config sealed', async () => {
    mockGetPlatformDid.mockReturnValue('did:imajin:platform');
    mockVaultExists.mockResolvedValue(false);

    expect(await quickbooksConfigSealed('did:owner')).toBe(false);
  });
});

describe('quickbooksTokenSealed', () => {
  it('returns false when token not sealed', async () => {
    mockVaultExists.mockResolvedValueOnce(false);
    expect(await quickbooksTokenSealed('did:owner')).toBe(false);
  });

  it('returns true when token is sealed', async () => {
    mockVaultExists.mockResolvedValueOnce(true);
    expect(await quickbooksTokenSealed('did:owner')).toBe(true);
  });
});

describe('quickbooksCredentialPending (#1521)', () => {
  it('is false when both config and token are ready', async () => {
    mockVaultStatus.mockResolvedValue('ready');
    expect(await quickbooksCredentialPending('did:owner')).toBe(false);
  });

  it('is true when the config is pending a grant', async () => {
    mockVaultStatus.mockImplementation((field: string) =>
      Promise.resolve(field.startsWith('quickbooks-config:') ? 'pending-grant' : 'ready'),
    );
    expect(await quickbooksCredentialPending('did:owner')).toBe(true);
  });

  it('is true when the token is pending a grant', async () => {
    mockVaultStatus.mockImplementation((field: string) =>
      Promise.resolve(field.startsWith('quickbooks-oauth:') ? 'pending-grant' : 'ready'),
    );
    expect(await quickbooksCredentialPending('did:owner')).toBe(true);
  });
});
