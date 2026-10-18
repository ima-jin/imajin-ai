import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRegistryAppBaseUrl } from '../registry-url';

const mocks = vi.hoisted(() => ({ limit: vi.fn(), where: vi.fn() }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: mocks.where }) }) },
  registryApps: { slug: 'slug', status: 'status', entryUrl: 'entryUrl' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: string) => ({ column, value }),
  and: (...conditions: unknown[]) => conditions,
}));

beforeEach(() => {
  mocks.where.mockReturnValue({ limit: mocks.limit });
  vi.stubEnv('APP_URL', 'https://node.test');
});
afterEach(() => vi.unstubAllEnvs());

describe('resolveRegistryAppBaseUrl', () => {
  it('reads active registry entries without nav placement or per-person membership', async () => {
    mocks.limit.mockResolvedValue([{ slug: 'fixture-studio', status: 'active', entryUrl: 'https://studio.example.test/' }]);
    vi.stubEnv('NEXT_PUBLIC_FIXTURE-STUDIO_URL', 'https://stale.test');
    await expect(resolveRegistryAppBaseUrl('fixture-studio')).resolves.toBe('https://studio.example.test');
    expect(mocks.where).toHaveBeenCalledWith([
      { column: 'slug', value: 'fixture-studio' }, { column: 'status', value: 'active' },
    ]);
  });

  it('resolves node-relative entries without a duplicate service prefix', async () => {
    mocks.limit.mockResolvedValue([{ slug: 'events', status: 'active', entryUrl: '/events' }]);
    await expect(resolveRegistryAppBaseUrl('events')).resolves.toBe('https://node.test/events');
  });

  it.each([
    [],
    [{ slug: 'events', status: 'revoked', entryUrl: 'https://old.test' }],
    [{ slug: null, status: 'active', entryUrl: 'https://old.test' }],
    [{ slug: 'events', status: 'active', entryUrl: null }],
    [{ slug: 'events', status: 'active', entryUrl: 'javascript:alert(1)' }],
    [{ slug: 'events', status: 'active', entryUrl: '/events/start?campaign=1' }],
  ].map((rows) => ({ rows })))('does not invent an endpoint for an absent or unsuitable registration %j', async ({ rows }) => {
    mocks.limit.mockResolvedValue(rows);
    await expect(resolveRegistryAppBaseUrl('events')).resolves.toBeNull();
  });

  it('propagates registry failures so callers choose their failure policy', async () => {
    mocks.limit.mockRejectedValue(new Error('offline'));
    await expect(resolveRegistryAppBaseUrl('events')).rejects.toThrow('offline');
  });
});
