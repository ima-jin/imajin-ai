import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ where: vi.fn() }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: mocks.where }) }) },
  registryApps: { slug: 'slug', status: 'status', visibility: 'visibility' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  inArray: (...args: unknown[]) => ({ inArray: args }),
  and: (...args: unknown[]) => ({ and: args }),
}));
import { projectPublicAppToggles } from '../public-app-toggles';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.where.mockResolvedValue([{ slug: 'coffee' }]);
});

describe('public profile app toggle projection', () => {
  it.each([undefined, null, {}, { enabledApps: [] }, { inference_enabled: true, show_events: true }])(
    'skips registry reads when no app slugs exist: %j',
    async toggles => {
      expect(await projectPublicAppToggles(toggles)).toBe(toggles);
      expect(mocks.where).not.toHaveBeenCalled();
    },
  );
  it('only requests active public registry slugs and strips everything else without mutating owner storage', async () => {
    const original = {
      enabledApps: ['coffee', 'private-app', 'unlisted-app', 'internal-app', 'retired-app'],
      coffee: 'coffee-handle', links: 'hidden-links', dykil: 'hidden-dykil', learn: 'hidden-learn',
      inference_enabled: true, show_market_items: true,
    };
    expect(await projectPublicAppToggles(original)).toEqual({
      enabledApps: ['coffee'], coffee: 'coffee-handle', links: null, dykil: null, learn: null,
      inference_enabled: true, show_market_items: true,
    });
    expect(mocks.where).toHaveBeenCalledWith({
      and: [
        { inArray: ['slug', ['coffee', 'private-app', 'unlisted-app', 'internal-app', 'retired-app', 'links', 'dykil', 'learn']] },
        { eq: ['status', 'active'] },
        { eq: ['visibility', 'public'] },
      ],
    });
    expect(original.links).toBe('hidden-links');
    expect(original.enabledApps).toContain('private-app');
  });
  it('filters legacy-only profiles without creating an explicit enabledApps preference', async () => {
    const result = await projectPublicAppToggles({ coffee: 'handle', links: 'secret', show_events: true });
    expect(result).toEqual({ coffee: 'handle', links: null, show_events: true });
    expect(result).not.toHaveProperty('enabledApps');
  });
});
