import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const { resolveApps } = vi.hoisted(() => ({ resolveApps: vi.fn() }));
vi.mock('@/src/lib/kernel/app-nav', () => ({ resolveRegistryAppsBySlug: resolveApps }));

import { ForestServices } from '../ForestServices';

afterEach(() => vi.clearAllMocks());

describe('ForestServices', () => {
  it('renders registry-only apps and allowed kernel services, not stale static app rows', async () => {
    resolveApps.mockResolvedValue([
      { slug: 'new-app', name: 'New App', icon: '🧩', entryUrl: 'https://apps.test/new' },
    ]);
    const result = await ForestServices({ enabledServices: ['chat', 'new-app', 'coffee', 'vault'], handle: 'ryan' });
    const html = renderToStaticMarkup(result);
    expect(html).toContain('New App');
    expect(html).toContain('https://apps.test/new/ryan');
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
