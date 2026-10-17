import { afterEach, describe, expect, it, vi } from 'vitest';
import { registryAppBaseUrl, registryAppPublicUrl } from '../public-url';

afterEach(() => vi.unstubAllEnvs());

describe('registryAppPublicUrl', () => {
  it.each([
    'https://app.test/coffee/start?mode=buy#support',
    '/coffee/start',
    '/coffee?mode=buy',
    '/coffee#support',
    '/coffee?',
  ])('keeps exact destination %s but refuses to infer an app base', (entryUrl) => {
    const app = { slug: 'coffee', entryUrl };
    expect(registryAppPublicUrl(app)).toBe(entryUrl);
    expect(registryAppBaseUrl(app)).toBeNull();
  });

  it.each(['/', '/coffee', 'https://app.test', 'https://app.test/', 'https://app.test/coffee'])(
    'recognizes only root or slug-base entry URL %s', (entryUrl) => {
      expect(registryAppBaseUrl({ slug: 'coffee', entryUrl })).toBe(entryUrl);
    },
  );

  it('does not invent API bases for missing or invalid destinations', () => {
    expect(registryAppBaseUrl({ slug: 'coffee', entryUrl: null })).toBeNull();
    expect(registryAppBaseUrl({ slug: 'coffee', entryUrl: 'javascript:alert(1)' })).toBeNull();
  });

  it('uses explicit app base overrides even when the registry entry is deep', () => {
    vi.stubEnv('NEXT_PUBLIC_COFFEE_URL', 'http://localhost:9555/base');
    expect(registryAppBaseUrl({ slug: 'coffee', entryUrl: '/coffee/start?launch=1' }))
      .toBe('http://localhost:9555/base');
  });
  it('uses the app entry URL rather than legacy localhost port hints', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'http://localhost:');
    expect(registryAppPublicUrl({ slug: 'coffee', entryUrl: 'https://apps.test/support' }))
      .toBe('https://apps.test/support');
    expect(registryAppPublicUrl({ slug: 'links', entryUrl: null })).toBe('/links');
  });

  it('honors an explicit local app endpoint', () => {
    vi.stubEnv('NEXT_PUBLIC_COFFEE_URL', 'http://localhost:9444');
    expect(registryAppPublicUrl({ slug: 'coffee', entryUrl: '/coffee' })).toBe('http://localhost:9444');
  });

  it('rejects unsafe registry destinations', () => {
    expect(registryAppPublicUrl({ slug: 'new-app', entryUrl: 'javascript:alert(1)' })).toBe('/new-app');
    expect(registryAppPublicUrl({ slug: 'new-app', entryUrl: '//evil.test' })).toBe('/new-app');
  });
});
