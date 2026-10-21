import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: [] as { slug: string | null; entryUrl: string | null }[], select: vi.fn() }));
vi.mock('@/src/db', () => ({
  registryApps: { slug: 'slug', entryUrl: 'entryUrl', status: 'status' },
  db: { select: state.select },
}));
import { listRegisteredEdgeApps } from '../edge-registry';

afterEach(() => vi.resetAllMocks());
function rows(value: typeof state.rows) {
  state.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => value }) }) });
}
describe('active registered-app edge inventory', () => {
  it('reads only public API-base metadata and validates it through the canonical URL helper', async () => {
    rows([{ slug: 'coffee', entryUrl: '/coffee' }, { slug: 'links', entryUrl: 'https://links.example.test' },
      { slug: 'unknown', entryUrl: '/unknown/start' }, { slug: null, entryUrl: null }]);
    expect(await listRegisteredEdgeApps()).toEqual([
      { slug: 'coffee', baseUrl: '/coffee' }, { slug: 'links', baseUrl: 'https://links.example.test' }, { slug: 'unknown', baseUrl: null },
    ]);
    expect(state.select).toHaveBeenCalledWith({ slug: 'slug', entryUrl: 'entryUrl' });
  });
  it('fails closed if the active registry exceeds the bounded inventory', async () => {
    rows(Array.from({ length: 501 }, () => ({ slug: 'fixture', entryUrl: null })));
    await expect(listRegisteredEdgeApps()).rejects.toThrow('inspection bound');
  });
});
