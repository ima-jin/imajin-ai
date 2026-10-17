import { beforeEach, describe, expect, it, vi } from 'vitest';
const { auth, read } = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock('@imajin/auth', () => ({
  requireAuth: auth,
  resolveActingDid: (identity: { id: string; actingFor?: string }) => identity.actingFor ?? identity.id,
}));
vi.mock('@/src/lib/loops/spend', () => ({ readRegistrySpend: read }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}), corsOptions: () => new Response(null, { status: 204 }),
}));
import { GET, OPTIONS } from '../route';
const principal = 'did:imajin:owner';
const request = (query = '') => new Request(`https://kernel.test/api/loops/spend${query}`) as Parameters<typeof GET>[0];
beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ identity: { id: principal } });
  read.mockResolvedValue({ runs: [], issues: [], prs: [] });
});
describe('GET /api/loops/spend', () => {
  it('requires authentication before reading', async () => {
    auth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await GET(request())).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });
  it('uses delegated effective principal and explicit month bounds', async () => {
    auth.mockResolvedValue({ identity: { id: 'did:imajin:agent', actingFor: principal } });
    const res = await GET(request('?window=2026-10'));
    expect(res.status).toBe(200);
    expect(read).toHaveBeenCalledWith(principal, '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
  it('rejects another principal and malformed windows without querying', async () => {
    expect((await GET(request('?principal=did:imajin:other'))).status).toBe(403);
    expect((await GET(request('?window=nope'))).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
  it('defaults the window and does not leak database errors', async () => {
    read.mockRejectedValue(new Error('private database url'));
    const res = await GET(request(`?principal=${principal}`));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('private');
  });
  it('serves CORS preflight', async () => {
    expect((await OPTIONS(request())).status).toBe(204);
  });
});
