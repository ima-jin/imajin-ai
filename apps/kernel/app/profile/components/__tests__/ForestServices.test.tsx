import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const { resolveApps } = vi.hoisted(() => ({ resolveApps: vi.fn() }));
vi.mock('@/src/lib/kernel/app-nav', () => ({ resolveRegistryAppsBySlug: resolveApps }));

import { ForestServices } from '../ForestServices';

afterEach(() => vi.clearAllMocks());

describe('ForestServices', () => {
  it('links deep entries exactly without adding a handle after query/hash', async () => {
    resolveApps.mockResolvedValue([
      { slug: 'new-app', name: 'New App', icon: '🧩', entryUrl: '/new-app/start?launch=1#buy' },
    ]);
    const html = renderToStaticMarkup(await ForestServices({ enabledServices: ['new-app'], handle: 'ryan' }));
    expect(html).toContain('href="/new-app/start?launch=1#buy"');
    expect(html).not.toContain('/ryan');
  });
  it('renders registry-only apps and allowed kernel services, not stale static app rows', async () => {
    resolveApps.mockResolvedValue([
      { slug: 'new-app', name: 'New App', icon: '🧩', entryUrl: 'https://apps.test/new-app' },
    ]);
    const result = await ForestServices({ enabledServices: ['chat', 'new-app', 'coffee', 'vault'], handle: 'ryan' });
    const html = renderToStaticMarkup(result);
    expect(html).toContain('New App');
    expect(html).toContain('https://apps.test/new-app/ryan');
    expect(html).toContain('Chat');
    expect(html).not.toContain('Coffee');
    expect(html).not.toContain('Vault');
  });

  it('renders nothing when no enabled app resolves', async () => {
    resolveApps.mockResolvedValue([]);
    expect(await ForestServices({ enabledServices: ['coffee'] })).toBeNull();
    expect(await ForestServices({ enabledServices: [] })).toBeNull();
  });
});
