import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── connector-oauth.ts — RFC 8628 device authorization grant (#1391) ────────
//
// Covers the three things the device path adds, and the one thing it must not
// break:
//   1. requestDeviceCode  — clientId-only POST, response parsing, error shapes.
//   2. pollDeviceTokenOnce — the four RFC 8628 states + sealing on success.
//   3. pollDeviceTokenAndStore — the poll loop: pacing, slow_down backoff, and
//      the two terminal failures.
//   4. The authorization-code path still refuses to run on a device config
//      (and still works on a full one).
//
// GitHub's endpoints are mocked at `fetch`; nothing here talks to a network.

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

import {
  createConnectorOAuth,
  resolveOAuthFlow,
  type BaseOAuthConfig,
  type OAuthTokenResponse,
} from '../connector-oauth';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const OWNER = 'did:imajin:eric';
const DEVICE_CODE_URL = 'https://provider.test/device/code';
const TOKEN_URL = 'https://provider.test/token';

interface TestTokens { accessToken: string; refreshToken?: string }

/** Device-mode config: clientId and nothing else — the whole point of #1391. */
const DEVICE_CONFIG: BaseOAuthConfig = { clientId: 'cid-device', flow: 'device' };

/** Legacy-shaped authorization-code config (no explicit `flow`). */
const AUTH_CODE_CONFIG: BaseOAuthConfig = {
  clientId: 'cid-web',
  clientSecret: 'csecret',
  redirectUri: 'https://imajin.test/callback',
};

function makeConnector(opts: { deviceCodeUrl?: string } = { deviceCodeUrl: DEVICE_CODE_URL }) {
  return createConnectorOAuth<BaseOAuthConfig, TestTokens>({
    name: 'testly',
    configPrefix: 'testly-config',
    tokenPrefix: 'testly-oauth',
    connectorDid: 'did:imajin:testly-connector',
    channel: 'testly',
    authorizeUrl: 'https://provider.test/authorize',
    tokenUrl: TOKEN_URL,
    deviceCodeUrl: opts.deviceCodeUrl,
    oauthScope: 'repo',
    tokenAuth: 'body',
    parseConfig: (raw) => raw as BaseOAuthConfig,
    buildTokens: (data: OAuthTokenResponse) => ({ accessToken: data.access_token as string }),
    shouldRefresh: () => false,
  });
}

const connector = makeConnector();

/** Seal `config` as the response the vault gives back for this DID. */
function sealedConfig(config: BaseOAuthConfig) {
  loadMock.mockResolvedValue(JSON.stringify(config));
}

/** A fetch stub that answers each call from `responses`, in order. */
function stubFetch(responses: ReadonlyArray<{ ok?: boolean; status?: number; body: unknown }>) {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: 'OK',
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    });
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Body of the Nth fetch call, parsed as URL-encoded form params. */
function requestBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): URLSearchParams {
  return new URLSearchParams(fetchMock.mock.calls[call][1].body as string);
}

/** A never-resolving sleep would hang the loop tests; this one just records. */
function recordingSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => { waits.push(ms); },
  };
}

const DEVICE_CODE_RESPONSE = {
  device_code: 'dev-code-xyz',
  user_code: 'ABCD-1234',
  verification_uri: 'https://provider.test/login/device',
  expires_in: 900,
  interval: 5,
};

beforeEach(() => {
  vi.unstubAllGlobals();
  sealMock.mockReset();
  loadMock.mockReset();
  sealedConfig(DEVICE_CONFIG);
});

// ── resolveOAuthFlow ─────────────────────────────────────────────────────────

describe('resolveOAuthFlow (#1391)', () => {
  it('treats a clientId-only config as device mode', () => {
    expect(resolveOAuthFlow({ clientId: 'cid' })).toBe('device');
  });

  it('treats a pre-#1391 config (secret + redirectUri, no flow) as authorization code', () => {
    expect(resolveOAuthFlow(AUTH_CODE_CONFIG)).toBe('authorization_code');
  });

  it('lets an explicit flow override the inferred one', () => {
    expect(resolveOAuthFlow({ ...AUTH_CODE_CONFIG, flow: 'device' })).toBe('device');
    expect(resolveOAuthFlow({ clientId: 'cid', flow: 'authorization_code' })).toBe('authorization_code');
  });
});

// ── requestDeviceCode ────────────────────────────────────────────────────────

describe('requestDeviceCode', () => {
  it('POSTs client_id + scope to the device endpoint', async () => {
    const fetchMock = stubFetch([{ body: DEVICE_CODE_RESPONSE }]);

    await connector.requestDeviceCode(OWNER);

    expect(fetchMock.mock.calls[0][0]).toBe(DEVICE_CODE_URL);
    const body = requestBody(fetchMock);
    expect(body.get('client_id')).toBe('cid-device');
    expect(body.get('scope')).toBe('repo');
  });

  it('sends no client_secret and no redirect_uri (the point of device flow)', async () => {
    const fetchMock = stubFetch([{ body: DEVICE_CODE_RESPONSE }]);

    await connector.requestDeviceCode(OWNER);

    const body = requestBody(fetchMock);
    expect(body.get('client_secret')).toBeNull();
    expect(body.get('redirect_uri')).toBeNull();
  });

  it('returns the user-facing code, verification URI, and pacing', async () => {
    stubFetch([{ body: { ...DEVICE_CODE_RESPONSE, verification_uri_complete: 'https://provider.test/login/device?user_code=ABCD-1234' } }]);

    const grant = await connector.requestDeviceCode(OWNER);

    expect(grant).toEqual({
      deviceCode: 'dev-code-xyz',
      userCode: 'ABCD-1234',
      verificationUri: 'https://provider.test/login/device',
      verificationUriComplete: 'https://provider.test/login/device?user_code=ABCD-1234',
      expiresIn: 900,
      interval: 5,
    });
  });

  it('falls back to RFC defaults when the provider omits interval/expires_in', async () => {
    stubFetch([{ body: { device_code: 'd', user_code: 'U', verification_uri: 'https://p.test/d' } }]);

    const grant = await connector.requestDeviceCode(OWNER);

    expect(grant.interval).toBe(5);
    expect(grant.expiresIn).toBe(900);
  });

  it('surfaces device_flow_disabled rather than pretending it started', async () => {
    stubFetch([{
      body: { error: 'device_flow_disabled', error_description: 'Device Flow is not enabled for this app' },
    }]);

    await expect(connector.requestDeviceCode(OWNER)).rejects.toThrow(
      /testly_device_code: device_flow_disabled/,
    );
  });

  it('throws on a non-2xx from the device endpoint', async () => {
    stubFetch([{ ok: false, status: 500, body: {} }]);

    await expect(connector.requestDeviceCode(OWNER)).rejects.toThrow(/testly_device_code: device endpoint 500/);
  });

  it('throws when the response is missing device_code / user_code / verification_uri', async () => {
    stubFetch([{ body: { user_code: 'ABCD-1234' } }]);

    await expect(connector.requestDeviceCode(OWNER)).rejects.toThrow(/missing device_code/);
  });

  it('refuses when the connector was built without a device endpoint', async () => {
    const noDevice = makeConnector({ deviceCodeUrl: undefined });

    expect(noDevice.supportsDeviceFlow()).toBe(false);
    await expect(noDevice.requestDeviceCode(OWNER)).rejects.toThrow(/testly_device_unsupported/);
  });

  it('reports device support when the endpoint is configured', () => {
    expect(connector.supportsDeviceFlow()).toBe(true);
  });
});

// ── pollDeviceTokenOnce ──────────────────────────────────────────────────────

describe('pollDeviceTokenOnce', () => {
  it('posts the RFC 8628 grant_type and the device code', async () => {
    const fetchMock = stubFetch([{ body: { error: 'authorization_pending' } }]);

    await connector.pollDeviceTokenOnce(OWNER, 'dev-code-xyz');

    expect(fetchMock.mock.calls[0][0]).toBe(TOKEN_URL);
    const body = requestBody(fetchMock);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(body.get('device_code')).toBe('dev-code-xyz');
    expect(body.get('client_id')).toBe('cid-device');
    // A public client must not send an empty client_secret.
    expect(body.get('client_secret')).toBeNull();
  });

  it.each([
    ['authorization_pending', 'pending'],
    ['slow_down', 'slow_down'],
    ['expired_token', 'expired'],
    ['access_denied', 'denied'],
  ])('maps %s to the %s poll status', async (providerError, expected) => {
    stubFetch([{ body: { error: providerError } }]);

    await expect(connector.pollDeviceTokenOnce(OWNER, 'dev-code-xyz')).resolves.toBe(expected);
  });

  it('never seals anything while the poll is still pending', async () => {
    stubFetch([{ body: { error: 'authorization_pending' } }]);

    await connector.pollDeviceTokenOnce(OWNER, 'dev-code-xyz');

    expect(sealMock).not.toHaveBeenCalled();
  });

  it('seals the token bundle per-DID and reports authorized', async () => {
    stubFetch([{ body: { access_token: 'gho_secret', token_type: 'bearer' } }]);

    await expect(connector.pollDeviceTokenOnce(OWNER, 'dev-code-xyz')).resolves.toBe('authorized');
    expect(sealMock).toHaveBeenCalledWith(
      `testly-oauth:${OWNER}`,
      JSON.stringify({ accessToken: 'gho_secret' }),
    );
  });

  it('throws on an unrecognised OAuth error rather than spinning forever', async () => {
    stubFetch([{ body: { error: 'incorrect_client_credentials' } }]);

    await expect(connector.pollDeviceTokenOnce(OWNER, 'dev-code-xyz')).rejects.toThrow(
      /testly_device_token: incorrect_client_credentials/,
    );
  });

  it('throws when the provider answers 200 with neither a token nor an error', async () => {
    stubFetch([{ body: {} }]);

    await expect(connector.pollDeviceTokenOnce(OWNER, 'dev-code-xyz')).rejects.toThrow(/no access_token/);
  });

  it('refuses when the connector has no device endpoint', async () => {
    const noDevice = makeConnector({ deviceCodeUrl: undefined });

    await expect(noDevice.pollDeviceTokenOnce(OWNER, 'd')).rejects.toThrow(/testly_device_unsupported/);
  });
});

// ── pollDeviceTokenAndStore (the loop) ───────────────────────────────────────

describe('pollDeviceTokenAndStore', () => {
  it('keeps polling while pending and resolves once authorized', async () => {
    const fetchMock = stubFetch([
      { body: { error: 'authorization_pending' } },
      { body: { error: 'authorization_pending' } },
      { body: { access_token: 'gho_secret' } },
    ]);
    const { waits, sleep } = recordingSleep();

    await connector.pollDeviceTokenAndStore(OWNER, 'dev-code-xyz', { interval: 5, expiresIn: 900, sleep });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([5000, 5000]);
    expect(sealMock).toHaveBeenCalledOnce();
  });

  it('backs off by 5s for each slow_down the provider sends', async () => {
    stubFetch([
      { body: { error: 'slow_down' } },
      { body: { error: 'authorization_pending' } },
      { body: { error: 'slow_down' } },
      { body: { access_token: 'gho_secret' } },
    ]);
    const { waits, sleep } = recordingSleep();

    await connector.pollDeviceTokenAndStore(OWNER, 'dev-code-xyz', { interval: 5, expiresIn: 900, sleep });

    // 5s base → +5 on the first slow_down (held across the pending tick) → +5 again.
    expect(waits).toEqual([10_000, 10_000, 15_000]);
  });

  it('throws device_denied when the owner declines', async () => {
    stubFetch([{ body: { error: 'access_denied' } }]);
    const { sleep } = recordingSleep();

    await expect(
      connector.pollDeviceTokenAndStore(OWNER, 'dev-code-xyz', { interval: 5, expiresIn: 900, sleep }),
    ).rejects.toThrow(/testly_device_denied/);
    expect(sealMock).not.toHaveBeenCalled();
  });

  it('throws device_expired when the provider reports expired_token', async () => {
    stubFetch([{ body: { error: 'expired_token' } }]);
    const { sleep } = recordingSleep();

    await expect(
      connector.pollDeviceTokenAndStore(OWNER, 'dev-code-xyz', { interval: 5, expiresIn: 900, sleep }),
    ).rejects.toThrow(/testly_device_expired/);
  });

  it('gives up on its own once the expiry budget is spent', async () => {
    // Two ticks fit in a 12s budget at 5s pacing; the third wait would overrun.
    const fetchMock = stubFetch([
      { body: { error: 'authorization_pending' } },
      { body: { error: 'authorization_pending' } },
      { body: { error: 'authorization_pending' } },
    ]);
    const { waits, sleep } = recordingSleep();

    await expect(
      connector.pollDeviceTokenAndStore(OWNER, 'dev-code-xyz', { interval: 5, expiresIn: 12, sleep }),
    ).rejects.toThrow(/testly_device_expired/);

    expect(waits).toEqual([5000, 5000]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

// ── The authorization-code path must not regress ─────────────────────────────

describe('authorization-code path alongside device flow', () => {
  it('refuses to build an authorize URL from a device-mode config', async () => {
    sealedConfig(DEVICE_CONFIG);

    await expect(connector.buildAuthorizeUrl(OWNER, 'state123')).rejects.toThrow(/testly_flow_mismatch/);
  });

  it('refuses to exchange a code against a device-mode config', async () => {
    sealedConfig(DEVICE_CONFIG);

    await expect(connector.exchangeCodeAndStore(OWNER, 'code123')).rejects.toThrow(/testly_flow_mismatch/);
  });

  it('still builds the authorize URL for a full authorization-code config', async () => {
    sealedConfig(AUTH_CODE_CONFIG);

    const url = new URL(await connector.buildAuthorizeUrl(OWNER, 'state123'));

    expect(url.searchParams.get('client_id')).toBe('cid-web');
    expect(url.searchParams.get('redirect_uri')).toBe('https://imajin.test/callback');
    expect(url.searchParams.get('state')).toBe('state123');
  });

  it('still sends client_secret on the authorization-code token exchange', async () => {
    sealedConfig(AUTH_CODE_CONFIG);
    const fetchMock = stubFetch([{ body: { access_token: 'gho_secret' } }]);

    await connector.exchangeCodeAndStore(OWNER, 'code123');

    const body = requestBody(fetchMock);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_secret')).toBe('csecret');
    expect(sealMock).toHaveBeenCalledWith(
      `testly-oauth:${OWNER}`,
      JSON.stringify({ accessToken: 'gho_secret' }),
    );
  });
});
