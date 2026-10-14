/**
 * Tests for apps/events/src/lib/pay-app-token.ts (#2739) — events' own
 * app-service token source. The signing key comes from `loadAppSigningKey`
 * (the standard claim-code path); nothing is minted or invented here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadAppSigningKey: vi.fn(),
  createAppServiceTokenProvider: vi.fn(),
  getToken: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@imajin/auth-client', () => ({
  loadAppSigningKey: mocks.loadAppSigningKey,
  createAppServiceTokenProvider: mocks.createAppServiceTokenProvider,
}));

import { getPayAppToken, invalidatePayAppToken, postPayAsApp, resetPayAppTokenForTests } from '../lib/pay-app-token';
import { getEventsAppDid, getEventsSigningIdentity } from '../lib/app-identity';

const KERNEL_URL = 'https://kernel.test';
const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  resetPayAppTokenForTests();
  process.env.IMAJIN_KERNEL_URL = KERNEL_URL;
  process.env.PAY_SERVICE_URL = `${KERNEL_URL}/pay`;
  mocks.loadAppSigningKey.mockResolvedValue({ appDid: 'did:imajin:events', privateKey: 'hex-key', publicKey: null });
  mocks.getToken.mockResolvedValue('app-token');
  mocks.createAppServiceTokenProvider.mockReturnValue({ getToken: mocks.getToken, invalidate: mocks.invalidate });
});

describe('postPayAsApp', () => {
  it('sends the app token and preserves the user Cookie and setup metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const body = { amount: 100, currency: 'CAD', metadata: { eventId: 'evt_1', backerDid: 'did:imajin:backer' } };
    await postPayAsApp('/api/setup-intent', body, 'imajin_session=user');
    expect(fetchMock).toHaveBeenCalledWith(`${KERNEL_URL}/pay/api/setup-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer app-token', Cookie: 'imajin_session=user' },
      body: JSON.stringify(body),
    });
  });

  it('invalidates on 401 and retries exactly once with a fresh token and unchanged body', async () => {
    mocks.getToken.mockResolvedValueOnce('expired').mockResolvedValueOnce('fresh');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await postPayAsApp('/api/refund', { paymentId: 'pi_1' })).status).toBe(401);
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init.headers.Authorization)).toEqual(['Bearer expired', 'Bearer fresh']);
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Cookie');
  });

  it.each([200, 400, 403, 500])('does not retry status %s', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await postPayAsApp('/api/charge-pledges', {})).status).toBe(status);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('fails closed when the token cannot be obtained', async () => {
    mocks.getToken.mockRejectedValueOnce(new Error('not provisioned'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(postPayAsApp('/api/refund', {})).rejects.toThrow('not provisioned');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed without a pay URL', async () => {
    delete process.env.PAY_SERVICE_URL;
    await expect(postPayAsApp('/api/refund', {})).rejects.toThrow('PAY_SERVICE_URL is not set');
    expect(mocks.getToken).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  resetPayAppTokenForTests();
});

describe('getPayAppToken', () => {
  it('shares one claim redemption with concurrent webhook audience resolution', async () => {
    delete process.env.IMAJIN_APP_DID;
    const [token, audience, identity] = await Promise.all([
      getPayAppToken(), getEventsAppDid(), getEventsSigningIdentity(),
    ]);
    expect(token).toBe('app-token');
    expect(audience).toBe('did:imajin:events');
    expect(identity.appDid).toBe(audience);
    expect(mocks.loadAppSigningKey).toHaveBeenCalledOnce();
    expect(mocks.createAppServiceTokenProvider).toHaveBeenCalledOnce();
  });

  it('uses its configured nonsecret app DID for callbacks without claiming again', async () => {
    process.env.IMAJIN_APP_DID = 'did:imajin:configured-test-app';
    expect(await getEventsAppDid()).toBe('did:imajin:configured-test-app');
    expect(mocks.loadAppSigningKey).not.toHaveBeenCalled();
  });
  it('loads the signing key via the claim-code path and returns a token minted from it', async () => {
    expect(await getPayAppToken()).toBe('app-token');

    expect(mocks.loadAppSigningKey).toHaveBeenCalledWith({ kernelUrl: KERNEL_URL, hostHint: 'events' });
    expect(mocks.createAppServiceTokenProvider).toHaveBeenCalledWith({
      kernelUrl: KERNEL_URL,
      appDid: 'did:imajin:events',
      privateKey: 'hex-key',
    });
  });

  it('loads the signing key once and reuses the provider (a claim code can only be redeemed once)', async () => {
    await Promise.all([getPayAppToken(), getPayAppToken()]);
    await getPayAppToken();

    expect(mocks.loadAppSigningKey).toHaveBeenCalledTimes(1);
    expect(mocks.createAppServiceTokenProvider).toHaveBeenCalledTimes(1);
    expect(mocks.getToken).toHaveBeenCalledTimes(3);
  });

  it('throws when IMAJIN_KERNEL_URL is not set, without trying to load a key', async () => {
    delete process.env.IMAJIN_KERNEL_URL;

    await expect(getPayAppToken()).rejects.toThrow('IMAJIN_KERNEL_URL is not set');
    expect(mocks.loadAppSigningKey).not.toHaveBeenCalled();
  });

  it('fails loud when events is not provisioned, and does not cache the failure', async () => {
    mocks.loadAppSigningKey.mockRejectedValueOnce(new Error('loadAppSigningKey: no keystore found and no claim code provided'));

    await expect(getPayAppToken()).rejects.toThrow('no claim code provided');
    expect(await getPayAppToken()).toBe('app-token');
    expect(mocks.loadAppSigningKey).toHaveBeenCalledTimes(2);
  });
});

describe('invalidatePayAppToken', () => {
  it('drops the cached token so the next call mints a fresh one', async () => {
    await invalidatePayAppToken();

    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });
});
