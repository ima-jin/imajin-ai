/**
 * Tests for apps/events/app/api/attending/[did]/route.ts (#2734)
 *
 * A DID holding a bought/given (`valid`), legacy `sold`, or checked-in (`used`)
 * ticket is attending; `held`, `available`, `cancelled`, refunded never are.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eventsTable, ticketsTable, NON_HOLDING_STATUSES, type Row } from './support/ticket-status-fake-db';

const mocks = vi.hoisted(() => ({ tables: new Map<object, Row[]>() }));

// No `@/` alias in vitest: resolve the shared constant to the real module (not a stub).
vi.mock('@/src/lib/ticket-holding', async () => await import('../lib/ticket-holding'));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('@imajin/db', () => ({
  // cohost lookup — returns no rows
  getClient: () => async () => [],
}));
vi.mock('drizzle-orm', async () => (await import('./support/ticket-status-fake-db')).drizzleOps);
vi.mock('@/src/db', async () => {
  const fake = await import('./support/ticket-status-fake-db');
  return {
    db: fake.createFakeDb(mocks.tables),
    events: fake.eventsTable,
    tickets: fake.ticketsTable,
  };
});

import { GET } from '../../app/api/attending/[did]/route';

const OWNER = 'did:imajin:holder';
const VIEWER = 'did:imajin:viewer';
const FUTURE = new Date(Date.now() + 86_400_000);

function eventRow(id: string, accessMode: string): Row {
  return {
    'events.id': id,
    'events.title': `Event ${id}`,
    'events.startsAt': FUTURE,
    'events.endsAt': null,
    'events.venue': null,
    'events.accessMode': accessMode,
    'events.imageUrl': null,
    'events.creatorDid': 'did:imajin:organizer',
    'events.status': 'published',
  };
}

function ticketRow(id: string, eventId: string, ownerDid: string, status: string): Row {
  return {
    'tickets.id': id,
    'tickets.eventId': eventId,
    'tickets.ownerDid': ownerDid,
    'tickets.status': status,
  };
}

function call(did: string, viewerDid?: string) {
  const url = new URL(`https://events.test/api/attending/${did}`);
  if (viewerDid) url.searchParams.set('viewer_did', viewerDid);
  const request = new Request(url) as Request & { nextUrl: URL };
  request.nextUrl = url;
  return GET(request as never, { params: Promise.resolve({ did }) });
}

beforeEach(() => {
  mocks.tables.clear();
  mocks.tables.set(ticketsTable, []);
  mocks.tables.set(eventsTable, []);
});

describe('GET /api/attending/[did] — holding statuses', () => {
  it.each(['valid', 'used', 'sold'])('lists the event for a %s ticket', async (status) => {
    mocks.tables.set(eventsTable, [eventRow('evt_1', 'public')]);
    mocks.tables.set(ticketsTable, [ticketRow('tkt_1', 'evt_1', OWNER, status)]);

    const res = await call(OWNER);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((e: { eventId: string }) => e.eventId)).toEqual(['evt_1']);
  });

  it.each(NON_HOLDING_STATUSES)('does not list the event for a %s ticket', async (status) => {
    mocks.tables.set(eventsTable, [eventRow('evt_1', 'public')]);
    mocks.tables.set(ticketsTable, [ticketRow('tkt_1', 'evt_1', OWNER, status)]);

    const res = await call(OWNER);

    expect(await res.json()).toEqual([]);
  });

  it("ignores other people's tickets", async () => {
    mocks.tables.set(eventsTable, [eventRow('evt_1', 'public')]);
    mocks.tables.set(ticketsTable, [ticketRow('tkt_1', 'evt_1', VIEWER, 'valid')]);

    expect(await (await call(OWNER)).json()).toEqual([]);
  });
});

describe('GET /api/attending/[did] — invite_only privacy uses the same holder rule', () => {
  beforeEach(() => {
    mocks.tables.set(eventsTable, [eventRow('evt_private', 'invite_only')]);
  });

  it.each(['valid', 'used', 'sold'])('shows a private event to a viewer holding a %s ticket', async (status) => {
    mocks.tables.set(ticketsTable, [
      ticketRow('tkt_owner', 'evt_private', OWNER, 'valid'),
      ticketRow('tkt_viewer', 'evt_private', VIEWER, status),
    ]);

    const body = await (await call(OWNER, VIEWER)).json();

    expect(body.map((e: { eventId: string }) => e.eventId)).toEqual(['evt_private']);
  });

  it.each(NON_HOLDING_STATUSES)('hides a private event from a viewer with a %s ticket', async (status) => {
    mocks.tables.set(ticketsTable, [
      ticketRow('tkt_owner', 'evt_private', OWNER, 'valid'),
      ticketRow('tkt_viewer', 'evt_private', VIEWER, status),
    ]);

    expect(await (await call(OWNER, VIEWER)).json()).toEqual([]);
  });

  it('hides a private event when there is no viewer', async () => {
    mocks.tables.set(ticketsTable, [ticketRow('tkt_owner', 'evt_private', OWNER, 'valid')]);

    expect(await (await call(OWNER)).json()).toEqual([]);
  });
});
