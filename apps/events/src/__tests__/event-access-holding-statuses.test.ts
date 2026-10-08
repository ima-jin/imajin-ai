/**
 * Tests for apps/events/app/api/events/[id]/access/route.ts (#2734)
 *
 * Runs the route's real status filter against fixture tickets: bought/given
 * (`valid`), legacy `sold` and checked-in (`used`) tickets pass the gate;
 * `held`, `available`, `cancelled` and refunded tickets never do.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eventsTable, ticketsTable, NON_HOLDING_STATUSES, type Row } from './support/ticket-status-fake-db';

const mocks = vi.hoisted(() => ({ tables: new Map<object, Row[]>() }));

// No `@/` alias in vitest: resolve the shared constant to the real module (not a stub).
vi.mock('@/src/lib/ticket-holding', async () => await import('../lib/ticket-holding'));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('@imajin/auth', () => ({
  requireAppAuth: async () => ({
    appAuth: { appDid: 'did:imajin:app', userDid: '', scopes: ['events:read'], attestationId: '' },
  }),
}));
vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));
vi.mock('drizzle-orm', async () => (await import('./support/ticket-status-fake-db')).drizzleOps);
vi.mock('@/src/db', async () => {
  const fake = await import('./support/ticket-status-fake-db');
  return {
    db: fake.createFakeDb(mocks.tables),
    events: fake.eventsTable,
    tickets: fake.ticketsTable,
  };
});

import { GET } from '../../app/api/events/[id]/access/route';

const DID = 'did:imajin:holder';
const OTHER = 'did:imajin:someone-else';

function ticketRow(id: string, eventId: string, ownerDid: string, status: string): Row {
  return {
    'tickets.id': id,
    'tickets.eventId': eventId,
    'tickets.ownerDid': ownerDid,
    'tickets.status': status,
  };
}

async function accessFor(did: string, eventId = 'evt_1') {
  const url = new URL(`https://events.test/api/events/${eventId}/access`);
  url.searchParams.set('did', did);
  const request = new Request(url, { headers: { authorization: 'Bearer app-token' } }) as Request & { nextUrl: URL };
  request.nextUrl = url;
  const res = await GET(request as never, { params: Promise.resolve({ id: eventId }) });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  mocks.tables.clear();
  mocks.tables.set(eventsTable, [{ 'events.id': 'evt_1' }]);
  mocks.tables.set(ticketsTable, []);
});

describe('GET /api/events/:id/access — holding statuses', () => {
  it.each(['valid', 'used', 'sold'])('grants access for a %s ticket', async (status) => {
    mocks.tables.set(ticketsTable, [ticketRow('tkt_1', 'evt_1', DID, status)]);

    expect(await accessFor(DID)).toEqual({ status: 200, body: { hasAccess: true } });
  });

  it.each(NON_HOLDING_STATUSES)('refuses access for a %s ticket', async (status) => {
    mocks.tables.set(ticketsTable, [ticketRow('tkt_1', 'evt_1', DID, status)]);

    expect(await accessFor(DID)).toEqual({ status: 200, body: { hasAccess: false } });
  });

  it('grants access when any one of several tickets is holding', async () => {
    mocks.tables.set(ticketsTable, [
      ticketRow('tkt_1', 'evt_1', DID, 'cancelled'),
      ticketRow('tkt_2', 'evt_1', DID, 'valid'),
    ]);

    expect((await accessFor(DID)).body).toEqual({ hasAccess: true });
  });

  it("does not grant access from another person's ticket or another event's ticket", async () => {
    mocks.tables.set(ticketsTable, [
      ticketRow('tkt_1', 'evt_1', OTHER, 'valid'),
      ticketRow('tkt_2', 'evt_other', DID, 'valid'),
    ]);

    expect((await accessFor(DID)).body).toEqual({ hasAccess: false });
  });
});
