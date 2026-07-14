/**
 * Tests for apps/events/app/api/events/[id]/tickets/[ticketId]/mark-refund-sent/route.ts
 *
 * Completes the e-transfer refund flow: organizer clicks "Mark Sent" after
 * manually sending the e-transfer, flipping ticket status from
 * 'refund_pending' → 'refunded'.
 *
 * Note: event lookup uses Drizzle (db.select); ticket SELECT and UPDATE
 * use raw SQL via getClient() — two separate mock systems.
 *
 * Cases:
 *  - 401 unauthenticated
 *  - 404 event not found
 *  - 403 non-organizer
 *  - 404 ticket not found
 *  - 400 ticket not in 'refund_pending' status (e.g. already 'refunded')
 *  - 200 flips 'refund_pending' → 'refunded'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  // Raw postgres client (getClient) — ticket SELECT and UPDATE
  const sqlMock = vi.fn().mockResolvedValue([]);

  // Drizzle select chain — event lookup only
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  const requireAuthMock = vi.fn();
  const isEventOrganizerMock = vi.fn();

  return { sqlMock, whereMock, fromMock, selectMock, requireAuthMock, isEventOrganizerMock };
});

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

vi.mock('@imajin/db', () => ({
  getClient: () => mocks.sqlMock,
}));

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  events: { id: 'col_id' },
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
}));

vi.mock('@/src/lib/organizer', () => ({
  isEventOrganizer: mocks.isEventOrganizerMock,
}));

// ─── Subject ────────────────────────────────────────────────────────────────

import { POST } from '../../app/api/events/[id]/tickets/[ticketId]/mark-refund-sent/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

const ROUTE_PARAMS = { params: Promise.resolve({ id: 'evt_1', ticketId: 'tkt_1' }) };

function makeRequest(): Request {
  return new Request('https://events.test/api/events/evt_1/tickets/tkt_1/mark-refund-sent', {
    method: 'POST',
    headers: { cookie: 'session=abc' },
  });
}

function nextDrizzleSelect(rows: unknown[]): void {
  const p = Promise.resolve(rows) as any;
  p.limit = vi.fn().mockResolvedValue(rows);
  mocks.whereMock.mockImplementationOnce(() => p);
}

function nextSql(rows: unknown[]): void {
  mocks.sqlMock.mockResolvedValueOnce(rows);
}

const BASE_EVENT = { id: 'evt_1', title: 'Test Event' };

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/events/[id]/tickets/[ticketId]/mark-refund-sent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.whereMock.mockReset();
    mocks.sqlMock.mockReset();
    mocks.sqlMock.mockResolvedValue([]);

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

  it('returns 404 when event is not found', async () => {
    nextDrizzleSelect([]);
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Event not found' });
  });

  it('returns 403 when caller is not an organizer', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: false });
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(403);
    expect(mocks.sqlMock).not.toHaveBeenCalled();
  });

  it('returns 404 when ticket is not found', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    nextSql([]);  // ticket SELECT → empty
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Ticket not found' });
  });

  it('returns 400 when ticket is not in refund_pending status', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    nextSql([{ id: 'tkt_1', status: 'refunded' }]);  // already refunded
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Ticket is not in refund_pending status' });
    // Only one SQL call (the SELECT) — no UPDATE
    expect(mocks.sqlMock).toHaveBeenCalledOnce();
  });

  it('flips refund_pending to refunded and returns the ticket', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    nextSql([{ id: 'tkt_1', status: 'refund_pending' }]);          // SELECT ticket
    nextSql([{ id: 'tkt_1', status: 'refunded' }]);                // UPDATE RETURNING

    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket.id).toBe('tkt_1');
    expect(body.ticket.status).toBe('refunded');
  });
});
