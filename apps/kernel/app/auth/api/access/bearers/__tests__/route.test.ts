/**
 * Tests for GET /auth/api/access/bearers (#2252) — lists the CALLER's own
 * bearers, metadata only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockListDelegateGrantBearersForPrincipal } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockListDelegateGrantBearersForPrincipal: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/access/delegate-grant', () => ({
  listDelegateGrantBearersForPrincipal: mockListDelegateGrantBearersForPrincipal,
}));

import { GET, OPTIONS } from '../route';

const PRINCIPAL_DID = 'did:imajin:ryan';

function makeReq(): Request {
  return new Request('https://test.imajin.ai/auth/api/access/bearers');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: PRINCIPAL_DID, scope: 'actor', subtype: 'human' } });
  mockListDelegateGrantBearersForPrincipal.mockResolvedValue([]);
});

describe('OPTIONS /auth/api/access/bearers', () => {
  it('delegates to the shared CORS preflight handler', async () => {
    const res = await OPTIONS(makeReq() as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
  });
});

describe('GET /auth/api/access/bearers', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
    expect(mockListDelegateGrantBearersForPrincipal).not.toHaveBeenCalled();
  });

  it("lists only the caller's own bearers", async () => {
    await GET(makeReq() as Parameters<typeof GET>[0]);
    expect(mockListDelegateGrantBearersForPrincipal).toHaveBeenCalledWith(PRINCIPAL_DID);
  });

  it('returns the bearers array from the lib, metadata only', async () => {
    const bearers = [{ bearerId: 'dgb_1', clientLabel: 'Muse Code', status: 'active' }];
    mockListDelegateGrantBearersForPrincipal.mockResolvedValue(bearers);

    const res = await GET(makeReq() as Parameters<typeof GET>[0]);
    const body = (await res.json()) as { bearers: unknown[] };
    expect(body.bearers).toEqual(bearers);
  });
});
