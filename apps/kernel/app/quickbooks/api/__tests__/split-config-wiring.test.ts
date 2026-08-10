import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── QuickBooks connect/callback routes — split app-owned config (#1704) ────
//
// Pins the actual route wiring (not just the shared factory, covered in
// connector-oauth-routes.test.ts): the connect route resolves a configDid from
// app-auth headers and signs it into state; the callback route recovers it
// from the verified state and threads it into `exchangeCodeAndStore`.

const { requireAuthMock, resolveActingDidMock, requireAppAuthMock, buildAuthorizeUrlMock, signStateMock, verifyStateMock, exchangeCodeAndStoreMock } =
  vi.hoisted(() => ({
    requireAuthMock: vi.fn(),
    resolveActingDidMock: vi.fn(() => 'did:imajin:owner'),
    requireAppAuthMock: vi.fn(),
    buildAuthorizeUrlMock: vi.fn(async () => 'https://appcenter.intuit.com/connect/oauth2?x=1'),
    signStateMock: vi.fn(() => 'state123'),
    verifyStateMock: vi.fn(() => ({ did: 'did:imajin:owner' })),
    exchangeCodeAndStoreMock: vi.fn(async () => undefined),
  }));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  resolveActingDid: resolveActingDidMock,
  requireAppAuth: requireAppAuthMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/src/db', () => ({ db: {}, channelLinks: {}, registryApps: {} }));
// #1770: the connect route now checks `vaultFieldExists` before it walks to a
// registrant DID. Defaulting to `true` here pins these tests to the
// "config already sealed at the app DID" case — the registrant walk itself is
// covered separately in `connector-oauth-registrant-walk.test.ts`.
vi.mock('@/src/lib/vault', () => ({ deleteFromVault: vi.fn(), vaultFieldExists: vi.fn(async () => true) }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

vi.mock('@/src/lib/quickbooks/connector', () => ({
  buildAuthorizeUrl: buildAuthorizeUrlMock,
  exchangeCodeAndStore: exchangeCodeAndStoreMock,
}));

vi.mock('@/src/lib/quickbooks/oauth-state', () => ({
  signState: signStateMock,
  verifyState: verifyStateMock,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body })),
    redirect: vi.fn((url: string | URL) => ({ status: 307, headers: { location: String(url) } })),
  },
  NextRequest: class {},
}));

function makeRequest(url: string, headers: Record<string, string> = {}) {
  return { url, headers: new Headers(headers) } as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ identity: {} });
  resolveActingDidMock.mockReset();
  resolveActingDidMock.mockReturnValue('did:imajin:owner');
  requireAppAuthMock.mockReset();
  buildAuthorizeUrlMock.mockClear();
  signStateMock.mockClear();
  verifyStateMock.mockReset();
  verifyStateMock.mockReturnValue({ did: 'did:imajin:owner' });
  exchangeCodeAndStoreMock.mockClear();
});

describe('QuickBooks connect route — resolveConfigDidFromAppAuth wiring', () => {
  it('signs and forwards the app DID when app-auth headers are present', async () => {
    requireAppAuthMock.mockResolvedValue({
      appAuth: { appDid: 'did:imajin:agrifortress', userDid: 'did:imajin:owner', scopes: [], attestationId: 'att' },
    });
    const { GET } = await import('../connect/route');

    await GET(makeRequest('https://kernel.test/quickbooks/api/connect', { authorization: 'Bearer app-token' }));

    expect(signStateMock).toHaveBeenCalledWith('did:imajin:owner', undefined, 'did:imajin:agrifortress');
    expect(buildAuthorizeUrlMock).toHaveBeenCalledWith('did:imajin:owner', 'state123', 'did:imajin:agrifortress');
  });

  it('behaves exactly like BYO-app when no app-auth headers are present', async () => {
    const { GET } = await import('../connect/route');

    await GET(makeRequest('https://kernel.test/quickbooks/api/connect'));

    expect(requireAppAuthMock).not.toHaveBeenCalled();
    expect(signStateMock).toHaveBeenCalledWith('did:imajin:owner', undefined);
    expect(buildAuthorizeUrlMock).toHaveBeenCalledWith('did:imajin:owner', 'state123', undefined);
  });
});

describe('QuickBooks callback route — appDid recovered from signed state', () => {
  it('threads the signed appDid into exchangeCodeAndStore as configDid', async () => {
    verifyStateMock.mockReturnValue({ did: 'did:imajin:owner', appDid: 'did:imajin:agrifortress' });
    const { GET } = await import('../callback/route');

    await GET(makeRequest('https://kernel.test/quickbooks/api/callback?code=abc&state=xyz&realmId=42'));

    expect(exchangeCodeAndStoreMock).toHaveBeenCalledWith('did:imajin:owner', 'abc', '42', 'did:imajin:agrifortress');
  });

  it('omits configDid when no appDid was signed (BYO-app, unchanged)', async () => {
    verifyStateMock.mockReturnValue({ did: 'did:imajin:owner' });
    const { GET } = await import('../callback/route');

    await GET(makeRequest('https://kernel.test/quickbooks/api/callback?code=abc&state=xyz&realmId=42'));

    expect(exchangeCodeAndStoreMock).toHaveBeenCalledWith('did:imajin:owner', 'abc', '42');
  });
});
