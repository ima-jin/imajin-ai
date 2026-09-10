import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Google connector route wiring (#2144) ──────────────────────────────────
//
// The shared factories (createConnectHandler / createCallbackHandler /
// createConfigureHandler / createDisconnectHandler / createConnectorScopeManifestRoute)
// are covered generically in connector-oauth-routes.test.ts and
// scope-manifest-route.test.ts. This pins the google-specific WIRING: which
// connector functions each route file passes to those factories, plus the one
// route with real custom logic — disconnect, which must revoke at Google
// BEFORE delegating to the shared vault-purge/grant-revoke handler.

const {
  requireAuthMock, resolveActingDidMock,
  buildAuthorizeUrlMock, exchangeCodeAndStoreMock, storeConfigMock,
  revokeAtGoogleMock, readConfigFlowMock,
  signStateMock, verifyStateMock,
  vaultFieldStatusMock,
  sharedDisconnectPostMock,
  createDisconnectHandlerMock,
} = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveActingDidMock: vi.fn(() => 'did:imajin:owner'),
  buildAuthorizeUrlMock: vi.fn(async () => 'https://accounts.google.com/o/oauth2/v2/auth?x=1'),
  exchangeCodeAndStoreMock: vi.fn(async () => undefined),
  storeConfigMock: vi.fn(async () => undefined),
  revokeAtGoogleMock: vi.fn(async () => undefined),
  readConfigFlowMock: vi.fn(async () => 'authorization_code' as const),
  signStateMock: vi.fn(() => 'state123'),
  verifyStateMock: vi.fn(() => ({ did: 'did:imajin:owner' })),
  vaultFieldStatusMock: vi.fn(async () => 'ready' as const),
  sharedDisconnectPostMock: vi.fn(async () => ({ status: 200, json: async () => ({ connected: false }) })),
  createDisconnectHandlerMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  resolveActingDid: resolveActingDidMock,
  // resolveConnectorOwnerDid (used by the scope-manifest route factory) tries
  // app-auth first; no test here exercises the app-auth path, so this always
  // reports "no app-auth context" and falls through to requireAuth.
  requireAppAuth: vi.fn(async () => ({ error: 'no app-auth', status: 401 })),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@/src/lib/vault', () => ({ vaultFieldStatus: vaultFieldStatusMock }));

// scope-manifest-route.ts -> connector-owner-did.ts imports `@/src/db` at
// module load time (for the app-owner-DID lookup) — not exercised by any
// path these tests take, but the import itself needs a live DATABASE_URL
// without this stub.
vi.mock('@/src/db', () => ({ db: {}, registryApps: {} }));

vi.mock('@/src/lib/google/connector', () => ({
  buildAuthorizeUrl: buildAuthorizeUrlMock,
  exchangeCodeAndStore: exchangeCodeAndStoreMock,
  storeConfig: storeConfigMock,
  revokeAtGoogle: revokeAtGoogleMock,
  readConfigFlow: readConfigFlowMock,
  configField: (did: string) => `google-config:${did}`,
  oauthVaultField: (did: string) => `google-oauth:${did}`,
  GOOGLE_CONNECTOR_DID: 'did:imajin:google-connector',
}));

vi.mock('@/src/lib/google/oauth-state', () => ({
  signState: signStateMock,
  verifyState: verifyStateMock,
}));

vi.mock('@/src/lib/google/scope-manifest', () => ({
  publishGoogleScopeManifest: vi.fn(async () => 'asset_google'),
  readActiveGoogleScopes: vi.fn(async () => []),
  findGoogleManifestAsset: vi.fn(async () => null),
  VALID_GOOGLE_SCOPES: [
    'google:gmail:read', 'google:gmail:send',
    'google:calendar:read', 'google:calendar:write',
    'google:drive:read', 'google:meet:records',
  ],
}));

// The real factory returns the POST handler directly (not wrapped in an
// object) — see `createDisconnectHandler` in connector-oauth-routes.ts.
createDisconnectHandlerMock.mockReturnValue(sharedDisconnectPostMock);

/**
 * Hand-written stand-ins for the shared route factories, scoped to exactly
 * the wiring contract each google route file depends on (which connector
 * function goes where). The factories' own internals (grant/vault/DB logic)
 * are covered generically in connector-oauth-routes.test.ts and
 * scope-manifest-route.test.ts — re-importing the real factories here would
 * also pull in `@/src/db`, which needs a live DATABASE_URL.
 */
vi.mock('@/src/lib/kernel/connector-oauth-routes', () => ({
  createConnectHandler:
    (buildAuthorizeUrl: (did: string, state: string, configDid?: string) => Promise<string>, signState: (did: string, returnTo?: string) => string) =>
    async (request: { url: string }) => {
      const auth = await requireAuthMock(request);
      if ('error' in auth) return { status: auth.status, json: async () => ({ error: auth.error }) };
      const ownerDid = resolveActingDidMock(auth.identity);
      const returnTo = new URL(request.url).searchParams.get('returnTo') ?? undefined;
      const state = signState(ownerDid, returnTo);
      const url = await buildAuthorizeUrl(ownerDid, state, undefined);
      return { status: 307, headers: { location: url } };
    },
  createCallbackHandler:
    (opts: { verifyState: (state: string) => { did: string; appDid?: string }; exchange: (did: string, code: string, params: URLSearchParams, appDid?: string) => Promise<void> }) =>
    async (request: { url: string }) => {
      const params = new URL(request.url).searchParams;
      const verified = opts.verifyState(params.get('state') ?? '');
      await opts.exchange(verified.did, params.get('code') ?? '', params, verified.appDid);
      return { status: 307 };
    },
  createConfigureHandler: (opts: {
    buildConfig: (base: Record<string, unknown>, body: Record<string, unknown>) => Record<string, unknown>;
    storeConfig: (did: string, config: Record<string, unknown>) => Promise<void>;
    supportsDeviceFlow?: boolean;
  }) => ({
    OPTIONS: async () => ({ status: 204 }),
    POST: async (request: { json: () => Promise<Record<string, unknown>> }) => {
      const body = await request.json();
      if (body.flow === 'device' && !opts.supportsDeviceFlow) {
        return { status: 400, json: async () => ({ error: 'device flow not supported' }) };
      }
      const base = { clientId: body.clientId, clientSecret: body.clientSecret, redirectUri: body.redirectUri, flow: body.flow };
      const config = opts.buildConfig(base, body);
      await opts.storeConfig('did:imajin:owner', config);
      return { status: 201, json: async () => ({ configured: true, flow: base.flow }) };
    },
  }),
  createDisconnectHandler: createDisconnectHandlerMock,
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
  buildAuthorizeUrlMock.mockClear();
  exchangeCodeAndStoreMock.mockClear();
  storeConfigMock.mockClear();
  revokeAtGoogleMock.mockReset();
  revokeAtGoogleMock.mockResolvedValue(undefined);
  signStateMock.mockClear();
  verifyStateMock.mockReset();
  verifyStateMock.mockReturnValue({ did: 'did:imajin:owner' });
  vaultFieldStatusMock.mockReset();
  vaultFieldStatusMock.mockResolvedValue('ready');
  sharedDisconnectPostMock.mockClear();
  sharedDisconnectPostMock.mockResolvedValue({ status: 200, json: async () => ({ connected: false }) });
});

describe('GET /google/api/connect', () => {
  it('wires buildAuthorizeUrl + signState from the google connector', async () => {
    const { GET } = await import('../connect/route');

    await GET(makeRequest('https://kernel.test/google/api/connect'));

    expect(signStateMock).toHaveBeenCalledWith('did:imajin:owner', undefined);
    expect(buildAuthorizeUrlMock).toHaveBeenCalledWith('did:imajin:owner', 'state123', undefined);
  });
});

describe('GET /google/api/callback', () => {
  it('exchanges the code via the google connector, no extra callback params', async () => {
    const { GET } = await import('../callback/route');

    await GET(makeRequest('https://kernel.test/google/api/callback?code=abc&state=xyz'));

    expect(exchangeCodeAndStoreMock).toHaveBeenCalledWith('did:imajin:owner', 'abc');
  });
});

describe('POST /google/api/configure', () => {
  it('seals the base OAuth triple via the google connector storeConfig', async () => {
    const { POST } = await import('../configure/route');

    const request = {
      headers: new Headers(),
      json: async () => ({ clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://imajin.test/google/api/callback' }),
    } as unknown as import('next/server').NextRequest;

    await POST(request);

    expect(storeConfigMock).toHaveBeenCalledWith(
      'did:imajin:owner',
      expect.objectContaining({ clientId: 'cid', clientSecret: 'csecret' }),
    );
  });

  it('does not support device flow (google has no RFC 8628 endpoint)', async () => {
    const { POST } = await import('../configure/route');

    const request = {
      headers: new Headers(),
      json: async () => ({ flow: 'device', clientId: 'cid' }),
    } as unknown as import('next/server').NextRequest;

    const res = await POST(request);

    expect(storeConfigMock).not.toHaveBeenCalled();
    expect((res as { status: number }).status).toBe(400);
  });
});

describe('GET+POST /google/api/scope-manifest', () => {
  it('reports configSealed/tokenSealed/flow from the connector vault fields', async () => {
    const { GET } = await import('../scope-manifest/route');

    const res = await GET(makeRequest('https://kernel.test/google/api/scope-manifest'));
    const body = await (res as { json: () => Promise<Record<string, unknown>> }).json();

    expect(body).toMatchObject({ configSealed: true, tokenSealed: true, flow: 'authorization_code' });
  });
});

describe('POST /google/api/disconnect (#2144 — revoke both directions)', () => {
  it('revokes at Google BEFORE delegating to the shared vault-purge/grant-revoke handler', async () => {
    const callOrder: string[] = [];
    revokeAtGoogleMock.mockImplementation(async () => { callOrder.push('revokeAtGoogle'); });
    sharedDisconnectPostMock.mockImplementation(async () => {
      callOrder.push('sharedDisconnect');
      return { status: 200, json: async () => ({ connected: false }) };
    });

    const { POST } = await import('../disconnect/route');
    await POST(makeRequest('https://kernel.test/google/api/disconnect'));

    expect(revokeAtGoogleMock).toHaveBeenCalledWith('did:imajin:owner');
    expect(sharedDisconnectPostMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['revokeAtGoogle', 'sharedDisconnect']);
  });

  it('still runs the shared disconnect even when the provider-side revoke throws (owner revoke must never be blocked)', async () => {
    revokeAtGoogleMock.mockRejectedValue(new Error('google unreachable'));

    const { POST } = await import('../disconnect/route');
    const res = await POST(makeRequest('https://kernel.test/google/api/disconnect'));

    expect(sharedDisconnectPostMock).toHaveBeenCalledTimes(1);
    expect((res as { status: number }).status).toBe(200);
  });

  it('skips revokeAtGoogle and still produces the shared handler response when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: 'not authenticated', status: 401 });
    sharedDisconnectPostMock.mockResolvedValue({ status: 401, json: async () => ({ error: 'not authenticated' }) });

    const { POST } = await import('../disconnect/route');
    const res = await POST(makeRequest('https://kernel.test/google/api/disconnect'));

    expect(revokeAtGoogleMock).not.toHaveBeenCalled();
    expect(sharedDisconnectPostMock).toHaveBeenCalledTimes(1);
    expect((res as { status: number }).status).toBe(401);
  });
});
