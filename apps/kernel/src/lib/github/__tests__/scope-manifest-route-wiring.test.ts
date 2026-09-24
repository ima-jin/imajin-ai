import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── GitHub scope-manifest ROUTE wiring test (#1521) ──────────────────────────
//
// Verifies the app route's getExtraFields distinguishes configSealed/tokenSealed
// (status === 'ready') from credentialPending (status === 'pending-grant'),
// rather than the old vaultFieldExists-only boolean that could not tell the two
// apart. GET/POST/OPTIONS behaviour is tested in
// src/lib/kernel/__tests__/scope-manifest-route.test.ts.

const { capturedOpts, mockHandlers, statusMock, readConfigFlowMock, countExternalGrantsMock } = vi.hoisted(() => ({
  capturedOpts: { current: null as Record<string, unknown> | null },
  mockHandlers: { GET: vi.fn(), POST: vi.fn(), OPTIONS: vi.fn() },
  statusMock: vi.fn(),
  readConfigFlowMock: vi.fn(),
  countExternalGrantsMock: vi.fn(),
}));

vi.mock('@/src/lib/kernel/scope-manifest-route', () => ({
  createConnectorScopeManifestRoute: vi.fn((opts: Record<string, unknown>) => {
    capturedOpts.current = opts;
    return mockHandlers;
  }),
}));

vi.mock('@/src/lib/github/scope-manifest', () => ({
  findGitHubManifestAsset: vi.fn(),
  readActiveGitHubScopes: vi.fn(),
  publishGitHubScopeManifest: vi.fn(),
  countExternalGitHubScopeGrantees: countExternalGrantsMock,
  VALID_GITHUB_SCOPES: ['github:read', 'github:write', 'github:org', 'github:actions'],
}));

vi.mock('@/src/lib/github/connector', () => ({
  configField: (did: string) => `github-config:${did}`,
  oauthVaultField: (did: string) => `github-oauth:${did}`,
  vaultField: (did: string) => `github-pat:${did}`,
  readConfigFlow: readConfigFlowMock,
}));

vi.mock('@/src/lib/vault', () => ({ vaultFieldStatus: statusMock }));

// Import triggers module evaluation → createConnectorScopeManifestRoute is called.
await import('../../../../app/github/api/scope-manifest/route');

const OWNER = 'did:imajin:owner';

describe('GitHub scope-manifest route wiring (#1521)', () => {
  beforeEach(() => {
    statusMock.mockReset();
    readConfigFlowMock.mockReset();
    readConfigFlowMock.mockResolvedValue(null);
    countExternalGrantsMock.mockReset();
    countExternalGrantsMock.mockResolvedValue(0);
  });

  async function getExtraFields(): Promise<Record<string, unknown>> {
    const fn = capturedOpts.current?.getExtraFields as (ownerDid: string) => Promise<Record<string, unknown>>;
    return fn(OWNER);
  }

  it('reports configSealed/tokenSealed true and credentialPending false when everything is ready', async () => {
    statusMock.mockResolvedValue('ready');
    readConfigFlowMock.mockResolvedValue('authorization_code');
    expect(await getExtraFields()).toEqual({
      configSealed: true,
      tokenSealed: true,
      credentialPending: false,
      flow: 'authorization_code',
      externalGrantClientCount: 0,
    });
  });

  it('reports credentialPending true (and sealed booleans false) when the config is pending a grant', async () => {
    statusMock.mockImplementation((field: string) =>
      Promise.resolve(field.startsWith('github-config:') ? 'pending-grant' : 'absent'),
    );
    expect(await getExtraFields()).toEqual({
      configSealed: false,
      tokenSealed: false,
      credentialPending: true,
      flow: null,
      externalGrantClientCount: 0,
    });
  });

  it('reports tokenSealed true when the PAT is ready even if the OAuth bundle is absent', async () => {
    statusMock.mockImplementation((field: string) =>
      Promise.resolve(field.startsWith('github-pat:') ? 'ready' : 'absent'),
    );
    expect(await getExtraFields()).toMatchObject({ tokenSealed: true, credentialPending: false });
  });

  it('reports nothing pending when the entry is unverifiable (fails closed, not opened as pending)', async () => {
    statusMock.mockResolvedValue('unverifiable');
    expect(await getExtraFields()).toEqual({
      configSealed: false,
      tokenSealed: false,
      credentialPending: false,
      flow: null,
      externalGrantClientCount: 0,
    });
  });

  // ── External MCP/OAuth-client grant pointer (#2308) ────────────────────────

  it('reports externalGrantClientCount from the external-grantee count query', async () => {
    statusMock.mockResolvedValue('ready');
    countExternalGrantsMock.mockResolvedValue(3);

    expect(await getExtraFields()).toMatchObject({ externalGrantClientCount: 3 });
  });

  it('degrades externalGrantClientCount to 0 rather than failing the whole status read', async () => {
    statusMock.mockResolvedValue('ready');
    countExternalGrantsMock.mockRejectedValue(new Error('db down'));

    expect(await getExtraFields()).toMatchObject({ configSealed: true, externalGrantClientCount: 0 });
  });

  // ── Device flow discriminator (#1391) ──────────────────────────────────────

  it('reports the sealed device-mode flow so the UI can show the right step 2', async () => {
    statusMock.mockResolvedValue('ready');
    readConfigFlowMock.mockResolvedValue('device');

    expect(await getExtraFields()).toMatchObject({ flow: 'device' });
  });

  it('degrades the flow to null rather than failing the whole status read', async () => {
    statusMock.mockResolvedValue('ready');
    readConfigFlowMock.mockRejectedValue(new Error('vault down'));

    expect(await getExtraFields()).toMatchObject({ configSealed: true, flow: null });
  });
});
