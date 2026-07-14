/**
 * Tests for apps/events/app/api/events/[id]/tickets/[ticketId]/registration-status/route.ts
 *
 * Auth is ticket-owner OR organizer (either passes).
 * Two Drizzle selects: ticket first, then ticket type for the surveyId.
 *
 * Cases:
 *  - 401 unauthenticated
 *  - 404 ticket not found
 *  - 403 when caller is neither owner nor organizer
 *  - 200 when caller is the ticket owner (non-organizer)
 *  - 200 when caller is an organizer (not the owner)
 *  - Returns correct registration status and surveyId from ticket type
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  // Drizzle select chain — two sequential calls (ticket, then ticket type)
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  const requireAuthMock = vi.fn();
  const isEventOrganizerMock = vi.fn();

  return { whereMock, fromMock, selectMock, requireAuthMock, isEventOrganizerMock };
});

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  tickets: { id: 'col_id', eventId: 'col_eventId', ownerDid: 'col_ownerDid' },
  ticketTypes: { id: 'col_ttId', registrationFormId: 'col_formId' },
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
}));

vi.mock('@/src/lib/organizer', () => ({
  isEventOrganizer: mocks.isEventOrganizerMock,
}));

// ─── Subject ────────────────────────────────────────────────────────────────

import { GET } from '../../app/api/events/[id]/tickets/[ticketId]/registration-status/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

const ROUTE_PARAMS = { params: Promise.resolve({ id: 'evt_1', ticketId: 'tkt_1' }) };

function makeRequest(): Request {
  return new Request('https://events.test/api/events/evt_1/tickets/tkt_1/registration-status', {
    headers: { cookie: 'session=abc' },
  });
}

function nextSelect(rows: unknown[]): void {
  const p = Promise.resolve(rows) as any;
  p.limit = vi.fn().mockResolvedValue(rows);
  mocks.whereMock.mockImplementationOnce(() => p);
}

const BASE_TICKET = {
  id: 'tkt_1',
  ticketTypeId: 'tkt_type_1',
  ownerDid: 'did:imajin:attendee',
  registrationStatus: 'complete',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/events/[id]/tickets/[ticketId]/registration-status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.whereMock.mockReset();

    mocks.requireAuthMock.mockResolvedValue({
      identity: { id: 'did:imajin:organizer', actingAs: null },
    });
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: true });
  });

  it('returns 401 when auth fails', async () => {
    mocks.requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(401);
  });

  it('returns 404 when ticket is not found', async () => {
    nextSelect([]);
    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Ticket not found' });
  });

  it('returns 403 when caller is neither the ticket owner nor an organizer', async () => {
    // Ticket owner is someone else, and caller is not an organizer
    nextSelect([{ ...BASE_TICKET, ownerDid: 'did:imajin:someone-else' }]);
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: false });

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(403);
  });

  it('returns 200 when caller is the ticket owner (not an organizer)', async () => {
    // Caller is the owner — requireAuth returns the attendee DID
    mocks.requireAuthMock.mockResolvedValue({
      identity: { id: 'did:imajin:attendee', actingAs: null },
    });
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: false });

    nextSelect([BASE_TICKET]);                                      // (1) ticket
    nextSelect([{ registrationFormId: 'form_abc' }]);              // (2) ticket type

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('complete');
    expect(body.surveyId).toBe('form_abc');
    expect(body.ticketId).toBe('tkt_1');
  });

  it('returns 200 when caller is an organizer (not the owner)', async () => {
    // Caller is organizer, not the ticket owner
    nextSelect([BASE_TICKET]);                                      // (1) ticket
    nextSelect([{ registrationFormId: null }]);                    // (2) ticket type — no form

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('complete');
    expect(body.surveyId).toBeNull();
  });

  it('defaults status to "not_required" when registrationStatus is null', async () => {
    nextSelect([{ ...BASE_TICKET, registrationStatus: null }]);    // (1) ticket
    nextSelect([{ registrationFormId: null }]);                    // (2) ticket type

    const res = await GET(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('not_required');
  });
});
