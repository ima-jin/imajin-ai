/**
 * Tests for apps/events/app/api/events/[id]/access/route.ts (#2395)
 *
 * The ticket-holder gate: app-token-gated, answers exactly
 * `{ hasAccess: boolean }` and never returns ticket rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAppAuthMock: vi.fn(),
  // Queue of result sets, consumed in query order (event lookup, then ticket lookup).
  results: [] as unknown[][],
  limitMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/auth', () => ({
  requireAppAuth: mocks.requireAppAuthMock,
}));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => ({}),
}));

vi.mock('@/src/db', () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = mocks.limitMock;
  return {
    db: { select: () => chain },
    events: { id: 'events.id' },
    tickets: { id: 'tickets.id', eventId: 'tickets.eventId', ownerDid: 'tickets.ownerDid', status: 'tickets.status' },
  };
});

import { GET } from '../../app/api/events/[id]/access/route';

const DID = 'did:imajin:holder';
const ROUTE_PARAMS = { params: Promise.resolve({ id: 'evt_1' }) };

function makeRequest(opts: { did?: string | null; bearer?: boolean } = {}) {
  const { did = DID, bearer = true } = opts;
  const url = new URL('https://events.test/api/events/evt_1/access');
  if (did !== null) url.searchParams.set('did', did);
  const request = new Request(url, {
    headers: bearer ? { authorization: 'Bearer app-token' } : {},
  }) as Request & { nextUrl: URL };
  request.nextUrl = url;
  return request as never;
}

beforeEach(() => {
  mocks.results = [];
  mocks.requireAppAuthMock.mockReset();
  mocks.requireAppAuthMock.mockResolvedValue({
    appAuth: { appDid: 'did:imajin:app', userDid: '', scopes: ['events:read'], attestationId: '' },
  });
  mocks.limitMock.mockReset();
  mocks.limitMock.mockImplementation(async () => mocks.results.shift() ?? []);
});

describe('GET /api/events/:id/access — boolean gate', () => {
  it('returns hasAccess: true when the DID holds a ticket', async () => {
    mocks.results = [[{ id: 'evt_1' }], [{ id: 'tkt_1' }]];

    const res = await GET(makeRequest(), ROUTE_PARAMS);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasAccess: true });
  });

  it('returns hasAccess: false when the DID holds no ticket', async () => {
    mocks.results = [[{ id: 'evt_1' }], []];

    const res = await GET(makeRequest(), ROUTE_PARAMS);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasAccess: false });
  });

  it('never leaks ticket data — body is exactly { hasAccess }', async () => {
    mocks.results = [
      [{ id: 'evt_1', creatorDid: 'did:imajin:organizer' }],
      [{ id: 'tkt_1', ticketTypeId: 'tt_1', pricePaid: 5000, currency: 'CAD', ownerDid: DID, status: 'sold' }],
    ];

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    const body = await res.json();
    const raw = JSON.stringify(body);

    expect(Object.keys(body)).toEqual(['hasAccess']);
    expect(typeof body.hasAccess).toBe('boolean');
    for (const leaked of ['tkt_1', 'tt_1', '5000', 'CAD', 'organizer', 'sold']) {
      expect(raw).not.toContain(leaked);
    }
  });
});

describe('GET /api/events/:id/access — scope check', () => {
  it('requires the events:read scope from requireAppAuth', async () => {
    mocks.results = [[{ id: 'evt_1' }], []];

    await GET(makeRequest(), ROUTE_PARAMS);

    expect(mocks.requireAppAuthMock).toHaveBeenCalledWith(expect.anything(), { scope: 'events:read' });
  });

  it('returns 403 when the token lacks the required scope', async () => {
    mocks.requireAppAuthMock.mockResolvedValue({ error: "Scope 'events:read' was not granted", status: 403 });

    const res = await GET(makeRequest(), ROUTE_PARAMS);

    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty('hasAccess');
    expect(mocks.limitMock).not.toHaveBeenCalled();
  });

  it('returns 401 without a bearer token (session cookies are not accepted)', async () => {
    const res = await GET(makeRequest({ bearer: false }), ROUTE_PARAMS);

    expect(res.status).toBe(401);
    expect(mocks.requireAppAuthMock).not.toHaveBeenCalled();
    expect(mocks.limitMock).not.toHaveBeenCalled();
  });

  it('propagates an invalid-token rejection and never queries the db', async () => {
    mocks.requireAppAuthMock.mockResolvedValue({ error: 'Invalid or expired app token', status: 401, notAppToken: true });

    const res = await GET(makeRequest(), ROUTE_PARAMS);

    expect(res.status).toBe(401);
    expect(mocks.limitMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/events/:id/access — error paths', () => {
  it('returns 400 when the did param is missing', async () => {
    const res = await GET(makeRequest({ did: null }), ROUTE_PARAMS);

    expect(res.status).toBe(400);
    expect(mocks.limitMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the did param is blank', async () => {
    const res = await GET(makeRequest({ did: '   ' }), ROUTE_PARAMS);

    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown event and does not look up tickets', async () => {
    mocks.results = [[]];

    const res = await GET(makeRequest(), ROUTE_PARAMS);

    expect(res.status).toBe(404);
    expect(await res.json()).not.toHaveProperty('hasAccess');
    expect(mocks.limitMock).toHaveBeenCalledTimes(1);
  });

  it('returns 500 (no hasAccess) when the db lookup fails', async () => {
    mocks.limitMock.mockRejectedValue(new Error('db down'));

    const res = await GET(makeRequest(), ROUTE_PARAMS);

    expect(res.status).toBe(500);
    expect(await res.json()).not.toHaveProperty('hasAccess');
  });
});
