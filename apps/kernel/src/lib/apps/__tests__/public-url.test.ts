import { afterEach, describe, expect, it, vi } from 'vitest';
import { registryAppPublicUrl } from '../public-url';

afterEach(() => vi.unstubAllEnvs());

describe('registryAppPublicUrl', () => {
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
