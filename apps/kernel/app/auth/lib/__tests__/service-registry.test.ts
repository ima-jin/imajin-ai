import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('service-registry (#2275)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('lists every declared service as known', async () => {
    const { KNOWN_SERVICES } = await import('../service-registry');
    expect([...KNOWN_SERVICES].sort()).toEqual(
      ['coffee', 'dykil', 'events', 'learn', 'links', 'market', 'media', 'pay'].sort(),
    );
  });

  it('treats pay and media as kernel-native, and userspace apps as not', async () => {
    const { isKernelNativeService } = await import('../service-registry');
    expect(isKernelNativeService('pay')).toBe(true);
    expect(isKernelNativeService('media')).toBe(true);
    expect(isKernelNativeService('coffee')).toBe(false);
    expect(isKernelNativeService('unknown-service')).toBe(false);
  });

  it('reads the base URL for a userspace service from its NEXT_PUBLIC_* env var', async () => {
    process.env.NEXT_PUBLIC_COFFEE_URL = 'https://node.example/coffee';
    const { getServiceBaseUrl } = await import('../service-registry');
    expect(getServiceBaseUrl('coffee')).toBe('https://node.example/coffee');
  });

  it('returns an empty base URL for kernel-native services', async () => {
    const { getServiceBaseUrl } = await import('../service-registry');
    expect(getServiceBaseUrl('pay')).toBe('');
    expect(getServiceBaseUrl('media')).toBe('');
  });

  it('builds an embed src for a userspace service scoped to /dashboard and the did', async () => {
    process.env.NEXT_PUBLIC_MARKET_URL = 'https://node.example/market';
    const { buildEmbedSrc } = await import('../service-registry');
    expect(buildEmbedSrc('market', 'did:imajin:abc')).toBe(
      'https://node.example/market/dashboard?embed=hub&did=did%3Aimajin%3Aabc',
    );
  });

  it('builds a same-origin (no host) embed src for kernel-native services under their own path', async () => {
    const { buildEmbedSrc } = await import('../service-registry');
    expect(buildEmbedSrc('pay', 'did:imajin:abc')).toBe('/pay?embed=hub&did=did%3Aimajin%3Aabc');
    expect(buildEmbedSrc('media', 'did:imajin:abc')).toBe('/media?embed=hub&did=did%3Aimajin%3Aabc');
  });

  it('falls back to a relative /dashboard path when no base URL is configured', async () => {
    delete process.env.NEXT_PUBLIC_LEARN_URL;
    const { buildEmbedSrc } = await import('../service-registry');
    expect(buildEmbedSrc('learn', 'did:imajin:abc')).toBe('/dashboard?embed=hub&did=did%3Aimajin%3Aabc');
  });
});
