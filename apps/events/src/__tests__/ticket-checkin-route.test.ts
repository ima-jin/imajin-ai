/**
 * Tests for apps/events/app/api/events/[id]/tickets/[ticketId]/check-in/route.ts
 *
 * Cases:
 *  - Success: valid ticket stamped used_at, checkin.create + event.attendance published
 *  - Already checked in (used_at set) → 400
 *  - Ticket not in 'valid' status → 400
 *  - Ticket not found → 404
 *  - Non-organizer → 403
 *  - Unauthenticated → 401
 *
 * Note: triggerHardEligibilityCheck and the optional CHECKIN_WEBHOOK_URL side effect
 * are fire-and-forget. They are exercised by the success test but not asserted on —
 * their internal SQL calls use the default sqlMock return ([]) which causes them to
 * exit early harmlessly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  // Raw postgres client. The check-in route uses only getClient() — no Drizzle.
  const sqlMock = vi.fn().mockResolvedValue([]);

  const requireAuthMock = vi.fn();
  const isEventOrganizerMock = vi.fn();
  const publishMock = vi.fn().mockResolvedValue(undefined);

  return { sqlMock, requireAuthMock, isEventOrganizerMock, publishMock };
});

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

vi.mock('@imajin/db', () => ({
  getClient: () => mocks.sqlMock,
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
}));

vi.mock('@/src/lib/organizer', () => ({
  isEventOrganizer: mocks.isEventOrganizerMock,
}));

vi.mock('@imajin/bus', () => ({
  publish: mocks.publishMock,
}));

// ─── Subject ────────────────────────────────────────────────────────────────

import { POST } from '../../app/api/events/[id]/tickets/[ticketId]/check-in/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(): Request {
  return new Request('https://events.test/api/events/evt_1/tickets/tkt_1/check-in', {
    method: 'POST',
    headers: { cookie: 'session=abc' },
  });
}

const ROUTE_PARAMS = { params: Promise.resolve({ id: 'evt_1', ticketId: 'tkt_1' }) };

/** Queue a raw SQL result for the next sqlMock call. */
function nextSql(rows: unknown[]): void {
  mocks.sqlMock.mockResolvedValueOnce(rows);
}

const VALID_TICKET = {
  id: 'tkt_1',
  status: 'valid',
  used_at: null,
  owner_did: 'did:imajin:attendee',
};

const USED_AT = '2026-07-14T14:00:00.000Z';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/events/[id]/tickets/[ticketId]/check-in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sqlMock.mockReset();
    mocks.sqlMock.mockResolvedValue([]);   // default: all extra SQL calls return []
    mocks.publishMock.mockResolvedValue(undefined);
    delete process.env.CHECKIN_WEBHOOK_URL;

    mocks.requireAuthMock.mockResolvedValue({
      identity: { id: 'did:imajin:organizer', actingAs: null },
    });
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: true });
  });

  it('returns 401 when auth fails', async () => {
    mocks.requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not an organizer', async () => {
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: false });
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(403);
    expect(mocks.sqlMock).not.toHaveBeenCalled();
  });

  it('returns 404 when ticket is not found', async () => {
    nextSql([]);   // ticket SELECT → empty
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Ticket not found' });
  });

  it('returns 400 when ticket status is not valid', async () => {
    nextSql([{ ...VALID_TICKET, status: 'held' }]);
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Ticket is not valid' });
    // No UPDATE should have been issued
    expect(mocks.sqlMock).toHaveBeenCalledOnce();
  });

  it('returns 400 when ticket is already checked in', async () => {
    nextSql([{ ...VALID_TICKET, used_at: USED_AT }]);
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Ticket already checked in' });
    expect(mocks.sqlMock).toHaveBeenCalledOnce();
  });

  it('stamps used_at, publishes checkin.create and event.attendance on success', async () => {
    nextSql([VALID_TICKET]);                                    // (1) SELECT ticket
    nextSql([{ id: 'tkt_1', used_at: USED_AT, status: 'used' }]); // (2) UPDATE RETURNING

    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket.id).toBe('tkt_1');
    expect(body.ticket.usedAt).toBe(USED_AT);

    // Both bus events published
    const publishedTypes = mocks.publishMock.mock.calls.map((c: any[]) => c[0]);
    expect(publishedTypes).toContain('checkin.create');
    expect(publishedTypes).toContain('event.attendance');

    // event.attendance carries the attendee DID
    const attendanceCall = mocks.publishMock.mock.calls.find((c: any[]) => c[0] === 'event.attendance');
    expect(attendanceCall![1]).toMatchObject({
      subject: 'did:imajin:attendee',
      payload: expect.objectContaining({ ticketId: 'tkt_1' }),
    });
  });
});
