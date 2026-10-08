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

import { getPayAppToken, invalidatePayAppToken, resetPayAppTokenForTests } from '../lib/pay-app-token';

const KERNEL_URL = 'https://kernel.test';
const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  resetPayAppTokenForTests();
  process.env.IMAJIN_KERNEL_URL = KERNEL_URL;
  mocks.loadAppSigningKey.mockResolvedValue({ appDid: 'did:imajin:events', privateKey: 'hex-key', publicKey: null });
  mocks.getToken.mockResolvedValue('app-token');
  mocks.createAppServiceTokenProvider.mockReturnValue({ getToken: mocks.getToken, invalidate: mocks.invalidate });
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetPayAppTokenForTests();
});

describe('getPayAppToken', () => {
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
