import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── QuickBooks scope-manifest ROUTE wiring test (#1521) ──────────────────────

const { capturedOpts, mockHandlers, configSealedMock, tokenSealedMock, credentialPendingMock } = vi.hoisted(() => ({
  capturedOpts: { current: null as Record<string, unknown> | null },
  mockHandlers: { GET: vi.fn(), POST: vi.fn(), OPTIONS: vi.fn() },
  configSealedMock: vi.fn(),
  tokenSealedMock: vi.fn(),
  credentialPendingMock: vi.fn(),
}));

vi.mock('@/src/lib/kernel/scope-manifest-route', () => ({
  createConnectorScopeManifestRoute: vi.fn((opts: Record<string, unknown>) => {
    capturedOpts.current = opts;
    return mockHandlers;
  }),
}));

vi.mock('@/src/lib/quickbooks/scope-manifest', () => ({
  findQuickBooksManifestAsset: vi.fn(),
  readActiveQuickBooksScopes: vi.fn(),
  publishQuickBooksScopeManifest: vi.fn(),
  quickbooksConfigSealed: configSealedMock,
  quickbooksTokenSealed: tokenSealedMock,
  quickbooksCredentialPending: credentialPendingMock,
  VALID_QUICKBOOKS_SCOPES: ['quickbooks:read', 'quickbooks:write'],
}));

// Import triggers module evaluation → createConnectorScopeManifestRoute is called.
await import('../../../../app/quickbooks/api/scope-manifest/route');

const OWNER = 'did:imajin:owner';

describe('QuickBooks scope-manifest route wiring (#1521)', () => {
  beforeEach(() => {
    configSealedMock.mockReset();
    tokenSealedMock.mockReset();
    credentialPendingMock.mockReset();
  });

  async function getExtraFields(): Promise<Record<string, unknown>> {
    const fn = capturedOpts.current?.getExtraFields as (ownerDid: string) => Promise<Record<string, unknown>>;
    return fn(OWNER);
  }

  it('reports configSealed/tokenSealed true and credentialPending false when everything is ready', async () => {
    configSealedMock.mockResolvedValue(true);
    tokenSealedMock.mockResolvedValue(true);
    credentialPendingMock.mockResolvedValue(false);
    expect(await getExtraFields()).toEqual({ configSealed: true, tokenSealed: true, credentialPending: false });
  });

  it('reports credentialPending true when sealed but awaiting an owner grant', async () => {
    configSealedMock.mockResolvedValue(false);
    tokenSealedMock.mockResolvedValue(false);
    credentialPendingMock.mockResolvedValue(true);
    expect(await getExtraFields()).toEqual({ configSealed: false, tokenSealed: false, credentialPending: true });
  });
});
