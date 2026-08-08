import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── connector-oauth.ts — split app-owned config vs. per-user tokens (#1704) ─
//
// Covers the optional trailing `configDid` on the entry points that read
// config: `buildAuthorizeUrl`, `exchangeCodeAndStore`, `loadAndRefreshTokens`,
// and `loadAccessToken`. In every case:
//   - config is loaded from `configDid` when supplied, else from `ownerDid`
//     (unchanged BYO-app behaviour);
//   - tokens are always sealed/read at `ownerDid`, regardless of `configDid`.

const { sealMock, loadMock } = vi.hoisted(() => ({
  sealMock: vi.fn(),
  loadMock: vi.fn(),
}));

vi.mock('@/src/lib/vault', () => ({ sealAndStoreV2: sealMock, loadAndUnseal: loadMock }));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) },
  channelLinks: {},
}));

import { createConnectorOAuth, type BaseOAuthConfig, type OAuthTokenResponse } from '../connector-oauth';

const OWNER = 'did:imajin:supplier';
const APP = 'did:imajin:agrifortress';

interface TestTokens { accessToken: string; refreshToken?: string; expiresAt: number }

const OWNER_CONFIG: BaseOAuthConfig = {
  clientId: 'owner-cid',
  clientSecret: 'owner-secret',
  redirectUri: 'https://imajin.test/callback',
};

const APP_CONFIG: BaseOAuthConfig = {
  clientId: 'app-cid',
  clientSecret: 'app-secret',
  redirectUri: 'https://imajin.test/callback',
};

function makeConnector(shouldRefresh: (tokens: TestTokens) => boolean = () => false) {
  return createConnectorOAuth<BaseOAuthConfig, TestTokens>({
    name: 'testly',
    configPrefix: 'testly-config',
    tokenPrefix: 'testly-oauth',
    connectorDid: 'did:imajin:testly-connector',
    channel: 'testly',
    authorizeUrl: 'https://provider.test/authorize',
    tokenUrl: 'https://provider.test/token',
    oauthScope: 'accounting',
    tokenAuth: 'basic',
    parseConfig: (raw) => raw as BaseOAuthConfig,
    buildTokens: (data: OAuthTokenResponse, _extra, previous) => ({
      accessToken: data.access_token as string,
      refreshToken: (data.refresh_token ?? previous?.refreshToken) as string,
      expiresAt: Date.now() + 3_600_000,
    }),
    shouldRefresh,
  });
}

/** Route `loadAndUnseal` by field prefix so owner-config and app-config differ. */
function sealedConfigs() {
  loadMock.mockImplementation((field: string) => {
    if (field === `testly-config:${OWNER}`) return Promise.resolve(JSON.stringify(OWNER_CONFIG));
    if (field === `testly-config:${APP}`) return Promise.resolve(JSON.stringify(APP_CONFIG));
    return Promise.resolve(undefined);
  });
}

function stubFetch(body: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  sealMock.mockReset();
  sealMock.mockResolvedValue(undefined);
  loadMock.mockReset();
  sealedConfigs();
});

describe('buildAuthorizeUrl with configDid', () => {
  it('uses the app-owned config when configDid is supplied', async () => {
    const connector = makeConnector();
    const url = new URL(await connector.buildAuthorizeUrl(OWNER, 'state123', APP));
    expect(url.searchParams.get('client_id')).toBe('app-cid');
  });

  it('falls back to the owner-owned config when configDid is omitted', async () => {
    const connector = makeConnector();
    const url = new URL(await connector.buildAuthorizeUrl(OWNER, 'state123'));
    expect(url.searchParams.get('client_id')).toBe('owner-cid');
  });
});

describe('exchangeCodeAndStore with configDid', () => {
  it('loads client credentials from configDid but seals tokens at ownerDid', async () => {
    const connector = makeConnector();
    const fetchMock = stubFetch({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });

    await connector.exchangeCodeAndStore(OWNER, 'code123', {}, APP);

    // HTTP Basic auth header carries the app's client credentials, not the owner's.
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    const expectedAuth = `Basic ${Buffer.from('app-cid:app-secret').toString('base64')}`;
    expect(headers.Authorization).toBe(expectedAuth);

    // The sealed token bundle still lands at the owner's vault field.
    expect(sealMock).toHaveBeenCalledWith(`testly-oauth:${OWNER}`, expect.any(String));
  });

  it('uses the owner-owned config when configDid is omitted (BYO-app, unchanged)', async () => {
    const connector = makeConnector();
    const fetchMock = stubFetch({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });

    await connector.exchangeCodeAndStore(OWNER, 'code123');

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    const expectedAuth = `Basic ${Buffer.from('owner-cid:owner-secret').toString('base64')}`;
    expect(headers.Authorization).toBe(expectedAuth);
  });
});

describe('loadAndRefreshTokens / loadAccessToken with configDid', () => {
  function sealedTokens(overrides: Partial<TestTokens> = {}) {
    loadMock.mockImplementation((field: string) => {
      if (field === `testly-config:${OWNER}`) return Promise.resolve(JSON.stringify(OWNER_CONFIG));
      if (field === `testly-config:${APP}`) return Promise.resolve(JSON.stringify(APP_CONFIG));
      if (field === `testly-oauth:${OWNER}`) {
        return Promise.resolve(JSON.stringify({
          accessToken: 'stale-at', refreshToken: 'rt', expiresAt: Date.now() - 1000, ...overrides,
        }));
      }
      return Promise.resolve(undefined);
    });
  }

  it('refreshes using the app-owned client credentials when configDid is supplied', async () => {
    const connector = makeConnector(() => true);
    sealedTokens();
    const fetchMock = stubFetch({ access_token: 'fresh-at', refresh_token: 'fresh-rt', expires_in: 3600 });

    const tokens = await connector.loadAndRefreshTokens(OWNER, APP);

    expect(tokens?.accessToken).toBe('fresh-at');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('app-cid:app-secret').toString('base64')}`);
    // Refreshed bundle is still sealed at the owner's field.
    expect(sealMock).toHaveBeenCalledWith(`testly-oauth:${OWNER}`, expect.any(String));
  });

  it('refreshes using the owner-owned config when configDid is omitted', async () => {
    const connector = makeConnector(() => true);
    sealedTokens();
    const fetchMock = stubFetch({ access_token: 'fresh-at', refresh_token: 'fresh-rt', expires_in: 3600 });

    await connector.loadAndRefreshTokens(OWNER);

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('owner-cid:owner-secret').toString('base64')}`);
  });

  it('loadAccessToken forwards configDid through to the refresh', async () => {
    const connector = makeConnector(() => true);
    sealedTokens();
    stubFetch({ access_token: 'fresh-at', refresh_token: 'fresh-rt', expires_in: 3600 });

    const accessToken = await connector.loadAccessToken(OWNER, APP);
    expect(accessToken).toBe('fresh-at');
  });

  it('does not need configDid when no refresh is required', async () => {
    const connector = makeConnector(() => false);
    sealedTokens({ accessToken: 'still-fresh', expiresAt: Date.now() + 3_600_000 });

    const tokens = await connector.loadAndRefreshTokens(OWNER, APP);
    expect(tokens?.accessToken).toBe('still-fresh');
    expect(sealMock).not.toHaveBeenCalled();
  });
});
