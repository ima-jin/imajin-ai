import { beforeEach, describe, expect, it, vi } from 'vitest';
const { auth, list } = vi.hoisted(() => ({ auth: vi.fn(), list: vi.fn() }));
vi.mock('@imajin/auth', () => ({
  requireAuth: auth,
  resolveActingDid: (identity: { id: string; actingAs?: string }) => identity.actingAs ?? identity.id,
}));
vi.mock('@/src/lib/github/corpus-credential', () => ({ listCorpusGitHubConnectors: list }));
import { GET } from '../route';
const request = {} as Parameters<typeof GET>[0];
beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ identity: { id: 'did:imajin:operator', actingAs: 'did:imajin:group' } });
  list.mockResolvedValue([{ ref: 'github:primary', label: 'GitHub · primary' }]);
});
describe('corpus connector picker endpoint', () => {
  it('queries the authenticated effective DID and returns references only without caching', async () => {
    const response = await GET(request);
    expect(list).toHaveBeenCalledWith('did:imajin:group');
    expect(await response.json()).toEqual({ connectors: [{ ref: 'github:primary', label: 'GitHub · primary' }] });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it.each([401, 403])('honors the auth boundary (%s) without enumeration', async status => {
    auth.mockResolvedValue({ error: 'Denied', status });
    expect((await GET(request)).status).toBe(status);
    expect(list).not.toHaveBeenCalled();
  });
  it('does not disclose vault/database error details', async () => {
    list.mockRejectedValue(new Error('private provider details'));
    const response = await GET(request);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'GitHub connectors unavailable' });
  });
});
