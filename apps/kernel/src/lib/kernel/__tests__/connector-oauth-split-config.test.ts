import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── connector-oauth.ts — split app-owned config vs. per-user tokens (#1704) ─
//
// Covers the optional trailing `configDid` on the entry points that read
// config: `buildAuthorizeUrl`, `exchangeCodeAndStore`, `loadAndRefreshTokens`,
// and `loadAccessToken`. In every case:
//   - config is loaded from `configDid` when supplied, else from `ownerDid`
//     (unchanged BYO-app behaviour);
//   - tokens are always sealed/read at `ownerDid`, regardless of `configDid`.

const { sealMock, loadMock, whereMock, recordMock } = vi.hoisted(() => ({
  sealMock: vi.fn(),
  loadMock: vi.fn(),
  whereMock: vi.fn().mockResolvedValue([]),
  recordMock: vi.fn(),
}));

vi.mock('@/src/lib/vault', () => ({ sealAndStoreV2: sealMock, loadAndUnseal: loadMock }));
vi.mock('../connector-registry-store', () => ({ recordConnectorRegistration: recordMock, readConnectorRegistration: vi.fn() }));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: whereMock }) }) },
  channelLinks: { slot: 'slot' },
}));

import { createConnectorOAuth, type BaseOAuthConfig, type OAuthTokenResponse } from '../connector-oauth';
import { withConnectorConnection } from '../connector-connection-context';
import { readConnectorRegistration } from '../connector-registry-store';

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
  whereMock.mockReset().mockResolvedValue([]);
  recordMock.mockReset();
  vi.mocked(readConnectorRegistration).mockReset();
});

describe('connection slots', () => {
  it('refuses reads, writes and stale callback token stores for removed slots without touching custody', async () => {
    vi.mocked(readConnectorRegistration).mockResolvedValue({ status: 'removed' } as never);
    const connector = makeConnector();
    for (const operation of [
      () => connector.storeConfig(OWNER, APP_CONFIG, 'work'),
      () => connector.loadConfig(OWNER, 'work'),
      () => connector.storeTokens(OWNER, { accessToken: 'unused-fixture', expiresAt: 1 }, 'work'),
      () => connector.loadTokens(OWNER, 'work'),
      () => connector.resolveActiveGrant(OWNER, 'testly:read', 'work'),
    ]) await expect(operation()).rejects.toThrow('Connection removed');
    expect(sealMock).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });
  it('restricts every grant lookup to the selected slot and propagates DB failures', async () => {
    const connector = makeConnector();
    expect(await connector.resolveActiveGrant(OWNER, 'testly:read', 'work')).toBe(false);
    expect(whereMock).toHaveBeenCalledWith(expect.arrayContaining([{ col: 'slot', val: 'work' }]));
    whereMock.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(connector.resolveActiveGrant(OWNER, 'testly:read', 'work')).rejects.toThrow('database unavailable');
  });
  it('preserves primary fields and isolates named config and token fields', async () => {
    const connector = makeConnector();
    expect(connector.configField(OWNER)).toBe(`testly-config:${OWNER}`);
    expect(connector.tokenField(OWNER, 'primary')).toBe(`testly-oauth:${OWNER}`);
    await connector.storeConfig(OWNER, APP_CONFIG, 'work');
    await connector.storeTokens(OWNER, { accessToken: 'work-at', expiresAt: 1 }, 'work');
    expect(sealMock).toHaveBeenCalledWith(`testly-config:${OWNER}:work`, JSON.stringify(APP_CONFIG));
    expect(sealMock).toHaveBeenCalledWith(`testly-oauth:${OWNER}:work`, expect.any(String));
    expect(recordMock).toHaveBeenCalledWith({ ownerDid: OWNER, provider: 'testly', slot: 'work', sealedKeyField: `testly-oauth:${OWNER}:work` });
    expect(await connector.loadTokens(OWNER, 'work')).toBeUndefined();
    await expect(connector.loadConfig(OWNER, 'work')).rejects.toThrow('testly_no_config');
  });

  it('defaults to the provider/owner context without borrowing primary tokens', async () => {
    const connector = makeConnector();
    loadMock.mockResolvedValue(undefined);
    await withConnectorConnection('testly', OWNER, 'work', async () => {
      expect(connector.tokenField(OWNER)).toBe(`testly-oauth:${OWNER}:work`);
      expect(connector.tokenField(APP)).toBe(`testly-oauth:${APP}`);
      expect(connector.tokenField(OWNER, 'primary')).toBe(`testly-oauth:${OWNER}`);
      expect(await connector.loadAccessToken(OWNER)).toBeUndefined();
    });
    expect(loadMock).toHaveBeenCalledWith(`testly-oauth:${OWNER}:work`);
    expect(loadMock).not.toHaveBeenCalledWith(`testly-oauth:${OWNER}`);
  });

  it('uses slot-specific BYO config, but explicit app config always uses shared primary', async () => {
    const connector = makeConnector();
    loadMock.mockImplementation(async (field: string) => {
      if (field === `testly-config:${OWNER}:work`) return JSON.stringify(OWNER_CONFIG);
      if (field === `testly-config:${APP}`) return JSON.stringify(APP_CONFIG);
    });
    expect(new URL(await connector.buildAuthorizeUrl(OWNER, 'state', undefined, 'work')).searchParams.get('client_id')).toBe('owner-cid');
    expect(new URL(await connector.buildAuthorizeUrl(OWNER, 'state', APP, 'work')).searchParams.get('client_id')).toBe('app-cid');
    expect(loadMock).not.toHaveBeenCalledWith(`testly-config:${APP}:work`);
  });

  it('persists configDid per slot and refreshes with the same app without a caller override', async () => {
    const connector = makeConnector(() => true);
    const vault = new Map<string, string>([[`testly-config:${APP}`, JSON.stringify(APP_CONFIG)]]);
    loadMock.mockImplementation(async (field: string) => vault.get(field));
    sealMock.mockImplementation(async (field: string, value: string) => { vault.set(field, value); });
    const fetchMock = stubFetch({ access_token: 'at', refresh_token: 'rt' });
    await connector.exchangeCodeAndStore(OWNER, 'code', {}, APP, 'work');
    expect(JSON.parse(vault.get(`testly-oauth:${OWNER}:work`)!)).toMatchObject({ configDid: APP });
    await connector.loadAndRefreshTokens(OWNER, undefined, 'work');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(loadMock).not.toHaveBeenCalledWith(`testly-config:${OWNER}:work`);
    expect(JSON.parse(vault.get(`testly-oauth:${OWNER}:work`)!)).toMatchObject({ configDid: APP });
    expect(vault.has(`testly-oauth:${OWNER}`)).toBe(false);
  });

  it('rejects invalid slots before authorize or exchange side effects even with shared config', async () => {
    const connector = makeConnector();
    const fetchMock = stubFetch({ access_token: 'at' });
    await expect(connector.buildAuthorizeUrl(OWNER, 'state', APP, '../primary')).rejects.toThrow('invalid_connection');
    await expect(connector.exchangeCodeAndStore(OWNER, 'code', {}, APP, '../primary')).rejects.toThrow('invalid_connection');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
  });
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
