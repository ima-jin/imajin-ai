/**
 * Tests for apps/market/src/lib/app-token.ts (#2740) — market mints its OWN
 * app-service token (proof of possession of its app key) for pay's checkout
 * and settle calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadAppSigningKey: vi.fn(),
  signBootstrapPayload: vi.fn(),
}));

vi.mock('@imajin/auth-client', () => ({
  loadAppSigningKey: mocks.loadAppSigningKey,
  signBootstrapPayload: mocks.signBootstrapPayload,
}));

import { getAppServiceToken, resetAppServiceTokenCache } from '../app-token';

const APP_DID = 'did:imajin:market-app';
const AUTH_URL = 'https://kernel.test/auth';
const TOKEN_URL = `${AUTH_URL}/api/apps/token/service`;
const SIGNATURE = 'sig-hex';
const MINT_FAILED = 'app-token: service token mint failed';

const fetchMock = vi.fn();

function mintResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mintedBody(): { appDid: string; nonce: string; timestamp: string; signature: string } {
  return JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
}

describe('getAppServiceToken', () => {
  beforeEach(() => {
    resetAppServiceTokenCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('AUTH_SERVICE_URL', AUTH_URL);
    mocks.loadAppSigningKey.mockReset().mockResolvedValue({ appDid: APP_DID, privateKey: 'priv-hex', publicKey: 'pub-hex' });
    mocks.signBootstrapPayload.mockReset().mockReturnValue(SIGNATURE);
    fetchMock.mockReset().mockImplementation(async () => mintResponse({ token: 'tok-1', expiresIn: 600, scopes: ['pay:settle'] }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('mints with proof of possession of the app key and returns the token', async () => {
    await expect(getAppServiceToken()).resolves.toBe('tok-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(TOKEN_URL);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('POST');

    const body = mintedBody();
    expect(body.appDid).toBe(APP_DID);
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(body.timestamp).toBe('2026-10-08T12:00:00.000Z');
    expect(body.signature).toBe(SIGNATURE);
    // The signature covers exactly the challenge the kernel reconstructs, signed with the app's own key.
    expect(mocks.signBootstrapPayload).toHaveBeenCalledWith(`${APP_DID}:${body.nonce}:${body.timestamp}`, 'priv-hex');
  });

  it('tolerates a trailing slash on AUTH_SERVICE_URL', async () => {
    vi.stubEnv('AUTH_SERVICE_URL', `${AUTH_URL}/`);
    await getAppServiceToken();
    expect(fetchMock.mock.calls[0]![0]).toBe(TOKEN_URL);
  });

  it('caches the token until 80% of its TTL, then mints a fresh one', async () => {
    await getAppServiceToken();
    await getAppServiceToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-10-08T12:07:59.000Z')); // 479s < 480s (80% of 600s)
    await getAppServiceToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => mintResponse({ token: 'tok-2', expiresIn: 600 }));
    vi.setSystemTime(new Date('2026-10-08T12:08:01.000Z')); // past 80%
    await expect(getAppServiceToken()).resolves.toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The signing key is fetched from the kernel once and held in memory.
    expect(mocks.loadAppSigningKey).toHaveBeenCalledTimes(1);
  });

  it('falls back to a 10-minute TTL when the response omits expiresIn', async () => {
    fetchMock.mockImplementation(async () => mintResponse({ token: 'tok-1' }));
    await getAppServiceToken();

    vi.setSystemTime(new Date('2026-10-08T12:07:59.000Z'));
    await getAppServiceToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent callers onto one mint', async () => {
    const [a, b, c] = await Promise.all([getAppServiceToken(), getAppServiceToken(), getAppServiceToken()]);
    expect([a, b, c]).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when AUTH_SERVICE_URL is not set', async () => {
    vi.stubEnv('AUTH_SERVICE_URL', '');
    await expect(getAppServiceToken()).rejects.toThrow('AUTH_SERVICE_URL is not set');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a signing-key load failure and retries it on the next call', async () => {
    mocks.loadAppSigningKey.mockRejectedValueOnce(new Error('loadAppSigningKey: no keystore found'));
    await expect(getAppServiceToken()).rejects.toThrow('no keystore found');
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(getAppServiceToken()).resolves.toBe('tok-1');
    expect(mocks.loadAppSigningKey).toHaveBeenCalledTimes(2);
  });

  it("surfaces the kernel's error string when the mint is refused", async () => {
    fetchMock.mockImplementation(async () => mintResponse({ error: 'App is not active' }, 403));
    await expect(getAppServiceToken()).rejects.toThrow(`${MINT_FAILED} (App is not active)`);
  });

  it('reports the status when the refusal has no JSON error body', async () => {
    fetchMock.mockImplementation(async () => new Response('nope', { status: 502 }));
    await expect(getAppServiceToken()).rejects.toThrow(`${MINT_FAILED} (status 502)`);
  });

  it('rejects a malformed success response', async () => {
    fetchMock.mockImplementation(async () => mintResponse({ expiresIn: 600 }));
    await expect(getAppServiceToken()).rejects.toThrow('mint response was malformed');
  });

  it('wraps a network failure without leaking anything but the cause message', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(getAppServiceToken()).rejects.toThrow('could not reach the auth service (connect ECONNREFUSED)');
  });

  it('wraps a non-Error network failure', async () => {
    fetchMock.mockRejectedValueOnce('boom');
    await expect(getAppServiceToken()).rejects.toThrow('could not reach the auth service (boom)');
  });

  it('does not cache a failed mint', async () => {
    fetchMock.mockImplementationOnce(async () => mintResponse({ error: 'Invalid proof-of-possession signature' }, 401));
    await expect(getAppServiceToken()).rejects.toThrow(MINT_FAILED);

    await expect(getAppServiceToken()).resolves.toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
