/**
 * Tests for the VAPID keypair module (#2291): the generator handed to
 * `getOrGenerateInternalSecret`, JSON parsing of the stored value, the
 * soft-fail-to-null contract on any failure, and `resolveVapidSubject`'s
 * env fallback chain.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetOrGenerateInternalSecret, mockGenerateVAPIDKeys } = vi.hoisted(() => ({
  mockGetOrGenerateInternalSecret: vi.fn(),
  mockGenerateVAPIDKeys: vi.fn(() => ({ publicKey: 'pub-key-b64url', privateKey: 'priv-key-b64url' })),
}));

vi.mock('../../vault/internal-secret', () => ({
  getOrGenerateInternalSecret: mockGetOrGenerateInternalSecret,
}));

vi.mock('web-push', () => ({
  generateVAPIDKeys: mockGenerateVAPIDKeys,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

import { getVapidKeys, getVapidPublicKey, resolveVapidSubject, VAPID_KEYS_PURPOSE } from '../vapid';

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerateVAPIDKeys.mockReturnValue({ publicKey: 'pub-key-b64url', privateKey: 'priv-key-b64url' });
});

afterEach(() => {
  delete process.env.VAPID_SUBJECT;
  delete process.env.APP_URL;
});

describe('getVapidKeys', () => {
  it('resolves the parsed keypair from the self-provisioned internal secret', async () => {
    mockGetOrGenerateInternalSecret.mockResolvedValue(JSON.stringify({ publicKey: 'pub', privateKey: 'priv' }));

    const keys = await getVapidKeys();

    expect(keys).toEqual({ publicKey: 'pub', privateKey: 'priv' });
    expect(mockGetOrGenerateInternalSecret).toHaveBeenCalledWith(VAPID_KEYS_PURPOSE, expect.any(Function));
  });

  it('passes a generator that produces a real VAPID keypair as JSON, not random bytes', async () => {
    mockGetOrGenerateInternalSecret.mockImplementation(async (_purpose: string, generate: () => string) => generate());

    const keys = await getVapidKeys();

    expect(mockGenerateVAPIDKeys).toHaveBeenCalledTimes(1);
    expect(keys).toEqual({ publicKey: 'pub-key-b64url', privateKey: 'priv-key-b64url' });
  });

  it('returns null (never throws) when the stored value is not valid JSON', async () => {
    mockGetOrGenerateInternalSecret.mockResolvedValue('not json');

    await expect(getVapidKeys()).resolves.toBeNull();
  });

  it('returns null when the stored value is JSON but missing a key', async () => {
    mockGetOrGenerateInternalSecret.mockResolvedValue(JSON.stringify({ publicKey: 'pub' }));

    await expect(getVapidKeys()).resolves.toBeNull();
  });

  it('returns null (never throws) when provisioning itself fails', async () => {
    mockGetOrGenerateInternalSecret.mockRejectedValue(new Error('vault unavailable'));

    await expect(getVapidKeys()).resolves.toBeNull();
  });
});

describe('getVapidPublicKey', () => {
  it('returns only the public half', async () => {
    mockGetOrGenerateInternalSecret.mockResolvedValue(JSON.stringify({ publicKey: 'pub', privateKey: 'priv' }));

    await expect(getVapidPublicKey()).resolves.toBe('pub');
  });

  it('returns null when no keypair is available', async () => {
    mockGetOrGenerateInternalSecret.mockResolvedValue('not json');

    await expect(getVapidPublicKey()).resolves.toBeNull();
  });
});

describe('resolveVapidSubject', () => {
  it('prefers VAPID_SUBJECT when set', () => {
    process.env.VAPID_SUBJECT = 'mailto:ops@example.com';
    process.env.APP_URL = 'https://example.com';

    expect(resolveVapidSubject()).toBe('mailto:ops@example.com');
  });

  it('falls back to APP_URL when VAPID_SUBJECT is unset', () => {
    process.env.APP_URL = 'https://node.example.com';

    expect(resolveVapidSubject()).toBe('https://node.example.com');
  });

  it('falls back to a generic mailto when neither is set', () => {
    expect(resolveVapidSubject()).toBe('mailto:ops@imajin.ai');
  });
});
