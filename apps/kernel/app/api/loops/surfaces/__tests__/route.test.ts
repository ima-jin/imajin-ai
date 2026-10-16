import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireAuth, mockListLoopSurfaces, mockResolveActingDid } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockListLoopSurfaces: vi.fn(),
  mockResolveActingDid: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: mockResolveActingDid,
}));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers({ 'access-control-allow-origin': 'https://app.imajin.ai' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/loops/surface-query', () => ({
  listLoopSurfaces: mockListLoopSurfaces,
}));

import { dynamic, GET, OPTIONS } from '../route';

const PRINCIPAL = 'did:imajin:owner';
const AGENT = 'did:imajin:agent';
const empty = { leases: [], conflicts: [], warnOnly: true };

function request(query = '') {
  return new Request(`https://test.imajin.ai/api/loops/surfaces${query}`) as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: PRINCIPAL } });
  mockResolveActingDid.mockReturnValue(PRINCIPAL);
  mockListLoopSurfaces.mockResolvedValue(empty);
});

describe('GET /api/loops/surfaces', () => {
  it('uses dynamic rendering and the shared CORS preflight', async () => {
    expect(dynamic).toBe('force-dynamic');
    const response = await OPTIONS(request());
    expect(response.status).toBe(204);
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });

  it.each([401, 403])('returns auth failure %s with CORS without querying', async (status) => {
    mockRequireAuth.mockResolvedValue({ error: 'Unauthorized', status });
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.imajin.ai');
    expect(mockListLoopSurfaces).not.toHaveBeenCalled();
    expect(mockResolveActingDid).not.toHaveBeenCalled();
  });

  it('reads only the authenticated principal by default', async () => {
    const req = request();
    const response = await GET(req);
    expect(mockRequireAuth).toHaveBeenCalledWith(req);
    expect(mockResolveActingDid).toHaveBeenCalledWith({ id: PRINCIPAL });
    expect(mockListLoopSurfaces).toHaveBeenCalledWith({
      principal: PRINCIPAL, loopId: null, limit: undefined,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.imajin.ai');
    expect(await response.json()).toEqual(empty);
  });

  it('uses the shared delegation resolver rather than the authenticated agent DID', async () => {
    const identity = { id: AGENT, actingFor: PRINCIPAL };
    mockRequireAuth.mockResolvedValue({ identity });
    await GET(request(`?principal=${PRINCIPAL}&loopId=loop_holder&limit=12`));
    expect(mockResolveActingDid).toHaveBeenCalledWith(identity);
    expect(mockListLoopSurfaces).toHaveBeenCalledWith({
      principal: PRINCIPAL, loopId: 'loop_holder', limit: 12,
    });
  });

  it.each([
    '?principal=did:imajin:other',
    `?principal=${PRINCIPAL}&principal=did:imajin:other`,
    '?principal=',
  ])('rejects spoofed principal %s before either read', async (query) => {
    const response = await GET(request(query));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'principal must match the authenticated caller' });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.imajin.ai');
    expect(mockListLoopSurfaces).not.toHaveBeenCalled();
  });

  it('rejects the agent DID when delegation resolves to a different principal', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: AGENT, actingFor: PRINCIPAL } });
    const response = await GET(request(`?principal=${AGENT}`));
    expect(response.status).toBe(403);
    expect(mockListLoopSurfaces).not.toHaveBeenCalled();
  });

  it.each([
    ['?limit=2000', 2000],
    ['?limit=-1', -1],
    ['?limit=1.8', 1.8],
    ['?limit=garbage', Number.NaN],
    ['?limit=10garbage', Number.NaN],
    ['?limit=', undefined],
  ])('passes numeric limit %s to the bounded query helper', async (query, limit) => {
    await GET(request(query));
    expect(mockListLoopSurfaces).toHaveBeenCalledWith({
      principal: PRINCIPAL, loopId: null, limit,
    });
  });

  it('returns leases and full conflict evidence without altering warn-only semantics', async () => {
    const result = {
      leases: [{ surface: 'repo://ima-jin/imajin-ai', loopId: 'loop_holder' }],
      conflicts: [{
        id: 'evt_conflict',
        payload: {
          surface: 'repo://ima-jin/imajin-ai',
          loopId: 'loop_claimant',
          refs: { conflictingLoopId: 'loop_holder' },
        },
      }],
      warnOnly: true,
    };
    mockListLoopSurfaces.mockResolvedValue(result);
    const response = await GET(request());
    expect(await response.json()).toEqual(result);
  });
});
