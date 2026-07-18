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

const { mockVaultExists } = vi.hoisted(() => ({ mockVaultExists: vi.fn().mockResolvedValue(false) }));
vi.mock('@/src/lib/vault', () => ({ vaultFieldExists: mockVaultExists }));

import {
  buildManifestContent,
  findQuickBooksManifestAsset,
  readActiveQuickBooksScopes,
  syncConsentGrants,
  publishQuickBooksScopeManifest,
  quickbooksConfigSealed,
  quickbooksTokenSealed,
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
  it('returns false when config not sealed', async () => {
    mockVaultExists.mockResolvedValueOnce(false);
    expect(await quickbooksConfigSealed('did:owner')).toBe(false);
  });

  it('returns true when config is sealed', async () => {
    mockVaultExists.mockResolvedValueOnce(true);
    expect(await quickbooksConfigSealed('did:owner')).toBe(true);
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
