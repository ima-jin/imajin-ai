/**
 * Tests for apps/events/app/api/events/[id]/cohosts/route.ts (GET/POST)
 *
 * #2155: this route used to run raw SQL directly against the kernel-owned
 * `connections.pod_members` table (a `SELECT` in GET, an `INSERT ... ON
 * CONFLICT DO NOTHING` in POST). It now calls the kernel connections
 * service's `GET /api/pods/{id}` and `POST /api/pods/{id}/members` routes
 * instead, forwarding the caller's session cookie.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const resultQueue: unknown[][] = [];
  function makeChain() {
    const value = resultQueue.shift() ?? [];
    const chain: any = {
      from: () => chain,
      where: () => chain,
      limit: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(value).then(resolve, reject),
    };
    return chain;
  }

  return {
    resultQueue,
    selectMock: vi.fn(() => makeChain()),
    requireAuthMock: vi.fn(),
    resolveCoHostDidMock: vi.fn(),
    fetchMock: vi.fn(),
  };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  events: { id: 'col_id', podId: 'col_pod_id', creatorDid: 'col_creator_did', did: 'col_did' },
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
  resolveActingDid: (identity: { actingAs?: string | null; id: string }) => identity.actingAs ?? identity.id,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/lib/cohost-helpers', () => ({
  resolveCoHostDid: mocks.resolveCoHostDidMock,
}));

vi.stubGlobal('fetch', mocks.fetchMock);

import { GET, POST } from '../route';

const ROUTE_PARAMS = { params: Promise.resolve({ id: 'evt_1' }) };
const EVENT_ROW = { id: 'evt_1', podId: 'pod_1', creatorDid: 'did:imajin:owner', did: 'did:imajin:event' };

function makeGetRequest(): Request {
  return new Request('https://events.test/api/events/evt_1/cohosts', { headers: { cookie: 'session=abc' } });
}

function makePostRequest(body: Record<string, unknown>): Request {
  return new Request('https://events.test/api/events/evt_1/cohosts', {
    method: 'POST',
    headers: { cookie: 'session=abc', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Builds a minimal fetch Response-like object. */
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resultQueue.length = 0;
  mocks.requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:owner', actingAs: null } });
});

describe('GET /api/events/[id]/cohosts — kernel pods API (#2155)', () => {
  it('fetches pod members from the kernel connections service, forwarding the cookie', async () => {
    mocks.resultQueue.push([EVENT_ROW]);
    mocks.fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/pods/pod_1')) {
        return Promise.resolve(
          fakeResponse(200, {
            pod: { id: 'pod_1' },
            members: [
              { podId: 'pod_1', did: 'did:imajin:cohost1', role: 'cohost', addedBy: 'did:imajin:owner', joinedAt: '2026-01-01T00:00:00Z', removedAt: null },
            ],
          }),
        );
      }
      return Promise.resolve(fakeResponse(200, { name: null, handle: null }));
    });

    const res = await GET(makeGetRequest(), ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cohosts).toHaveLength(1);
    expect(json.cohosts[0].addedAt).toBe('2026-01-01T00:00:00Z');

    const podFetchCall = mocks.fetchMock.mock.calls.find(([url]) => String(url).includes('/api/pods/pod_1'));
    expect(podFetchCall?.[1]?.headers).toMatchObject({ cookie: 'session=abc' });
  });

  it('filters out non-cohost members and removed members', async () => {
    mocks.resultQueue.push([EVENT_ROW]);
    mocks.fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/pods/pod_1')) {
        return Promise.resolve(
          fakeResponse(200, {
            members: [
              { podId: 'pod_1', did: 'did:imajin:owner-member', role: 'owner', addedBy: null, joinedAt: '2026-01-01', removedAt: null },
              { podId: 'pod_1', did: 'did:imajin:removed', role: 'cohost', addedBy: null, joinedAt: '2026-01-01', removedAt: '2026-02-01' },
            ],
          }),
        );
      }
      return Promise.resolve(fakeResponse(200, {}));
    });

    const res = await GET(makeGetRequest(), ROUTE_PARAMS);
    const json = await res.json();
    expect(json.cohosts).toHaveLength(0);
  });

  it('returns cohosts: [] without calling the connections service when the event has no pod', async () => {
    mocks.resultQueue.push([{ ...EVENT_ROW, podId: null }]);

    const res = await GET(makeGetRequest(), ROUTE_PARAMS);
    const json = await res.json();
    expect(json.cohosts).toEqual([]);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the event is not found', async () => {
    mocks.resultQueue.push([]);
    const res = await GET(makeGetRequest(), ROUTE_PARAMS);
    expect(res.status).toBe(404);
  });

  it('fails soft to an empty list when the connections service is unreachable', async () => {
    mocks.resultQueue.push([EVENT_ROW]);
    mocks.fetchMock.mockRejectedValue(new Error('network error'));

    const res = await GET(makeGetRequest(), ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cohosts).toEqual([]);
  });
});

describe('POST /api/events/[id]/cohosts — kernel pods API (#2155)', () => {
  beforeEach(() => {
    mocks.resolveCoHostDidMock.mockResolvedValue({ coHostDid: 'did:imajin:newcohost', profileData: { name: 'New Cohost', handle: 'newcohost' } });
  });

  it('adds a new cohost via the kernel pods/members endpoint, forwarding the cookie', async () => {
    mocks.resultQueue.push([EVENT_ROW]);
    mocks.fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/pods/pod_1/members')) {
        return Promise.resolve(
          fakeResponse(201, { member: { podId: 'pod_1', did: 'did:imajin:newcohost', role: 'cohost', addedBy: 'did:imajin:owner', joinedAt: '2026-03-01T00:00:00Z', removedAt: null } }),
        );
      }
      if (u.includes('/api/pods/pod_1')) {
        return Promise.resolve(fakeResponse(200, { members: [] }));
      }
      return Promise.resolve(fakeResponse(200, {}));
    });

    const res = await POST(makePostRequest({ did: 'did:imajin:newcohost' }), ROUTE_PARAMS);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.cohost).toMatchObject({ did: 'did:imajin:newcohost', addedAt: '2026-03-01T00:00:00Z' });

    const addCall = mocks.fetchMock.mock.calls.find(([url]) => String(url).includes('/members'));
    expect(addCall?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(addCall?.[1]?.body as string)).toEqual({ did: 'did:imajin:newcohost', role: 'cohost' });
  });

  it('is idempotent: re-adding an existing cohost succeeds without calling the kernel insert route', async () => {
    mocks.resultQueue.push([EVENT_ROW]);
    mocks.fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/api/pods/pod_1/members')) {
        throw new Error('should not be called for an existing member');
      }
      if (u.includes('/api/pods/pod_1')) {
        return Promise.resolve(
          fakeResponse(200, {
            members: [{ podId: 'pod_1', did: 'did:imajin:newcohost', role: 'cohost', addedBy: 'did:imajin:owner', joinedAt: '2026-01-01T00:00:00Z', removedAt: null }],
          }),
        );
      }
      return Promise.resolve(fakeResponse(200, {}));
    });

    const res = await POST(makePostRequest({ did: 'did:imajin:newcohost' }), ROUTE_PARAMS);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.cohost.addedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('returns 403 when the caller is not the event owner', async () => {
    mocks.requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:someone-else', actingAs: null } });
    mocks.resultQueue.push([EVENT_ROW]);

    const res = await POST(makePostRequest({ did: 'did:imajin:newcohost' }), ROUTE_PARAMS);
    expect(res.status).toBe(403);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a kernel error when adding the member fails', async () => {
    mocks.resultQueue.push([EVENT_ROW]);
    mocks.fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/api/pods/pod_1/members')) {
        return Promise.resolve(fakeResponse(403, { error: 'Only the owner can add members' }));
      }
      if (u.includes('/api/pods/pod_1')) {
        return Promise.resolve(fakeResponse(200, { members: [] }));
      }
      return Promise.resolve(fakeResponse(200, {}));
    });

    const res = await POST(makePostRequest({ did: 'did:imajin:newcohost' }), ROUTE_PARAMS);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('Only the owner can add members');
  });
});
