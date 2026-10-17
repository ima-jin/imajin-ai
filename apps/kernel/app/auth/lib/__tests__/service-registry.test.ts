import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildEmbedSrc, registryAppEmbedUrl } from '../service-registry';

afterEach(() => vi.unstubAllEnvs());

describe('service-registry (#2275, #2425 send-back)', () => {
  it('builds a relative dashboard path from the registry app base path', () => {
    expect(buildEmbedSrc('did:imajin:abc', '/learn')).toBe('/learn/dashboard?embed=hub&did=did%3Aimajin%3Aabc');
  });

  it('#2425: no literal app slug carries a hard-coded URL here — every non-kernel-native embed src is built from a caller-supplied baseUrl', () => {
    expect(buildEmbedSrc('did:imajin:abc', 'https://registry-resolved.example')).toBe(
      'https://registry-resolved.example/dashboard?embed=hub&did=did%3Aimajin%3Aabc',
    );
  });

  it('#2425 send-back: a baseUrl works for any slug, including one with no special-casing at all', () => {
    expect(buildEmbedSrc('did:imajin:abc', 'https://newapp.example')).toBe(
      'https://newapp.example/dashboard?embed=hub&did=did%3Aimajin%3Aabc',
    );
  });
});

describe('registryAppEmbedUrl', () => {
  it.each([
    '/app/home?x=1#files',
    'https://app.example/dashboard?x=1#files',
    '/app/dashboard/',
  ])('preserves the exact destination %s', (entryUrl) => {
    const result = registryAppEmbedUrl({ slug: 'exact-app', entryUrl }, 'did:imajin:group');
    const url = new URL(result, 'https://kernel.example');
    const original = new URL(entryUrl, 'https://kernel.example');
    expect(url.pathname).toBe(original.pathname);
    expect(url.hash).toBe(original.hash);
    expect(url.searchParams.get('x')).toBe(original.searchParams.get('x'));
    expect(url.searchParams.get('embed')).toBe('hub');
    expect(url.searchParams.get('did')).toBe('did:imajin:group');
  });

  it('overwrites stale hub parameters instead of duplicating them', () => {
    const result = registryAppEmbedUrl({ slug: 'exact-app', entryUrl: '/app?embed=old&did=old' }, 'did:imajin:group');
    const params = new URL(result, 'https://kernel.example').searchParams;
    expect(params.getAll('embed')).toEqual(['hub']);
    expect(params.getAll('did')).toEqual(['did:imajin:group']);
  });

  it('retains dashboard convention for an explicit environment base override', () => {
    vi.stubEnv('NEXT_PUBLIC_EXACT-APP_URL', 'https://override.example/base/');
    expect(registryAppEmbedUrl({ slug: 'exact-app', entryUrl: '/app/home?x=1' }, 'group')).toBe(
      'https://override.example/base/dashboard?embed=hub&did=group',
    );
  });

  it.each([null, 'javascript:bad'])('retains dashboard convention without a valid entry (%s)', (entryUrl) => {
    expect(registryAppEmbedUrl({ slug: 'exact-app', entryUrl }, 'group')).toBe(
      '/exact-app/dashboard?embed=hub&did=group',
    );
  });
});
