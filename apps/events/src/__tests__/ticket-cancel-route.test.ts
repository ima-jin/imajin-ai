/**
 * Tests for apps/events/app/api/events/[id]/tickets/[ticketId]/cancel/route.ts
 *
 * Key logic: only 'held' or 'available' tickets may be cancelled.
 * 'valid' (paid) tickets must go through refund instead.
 *
 * Cases:
 *  - 401 unauthenticated
 *  - 403 non-organizer
 *  - 404 ticket not found
 *  - 400 when ticket status is 'valid' (must use refund)
 *  - 400 when ticket status is 'refunded' (already done)
 *  - 200 cancels a 'held' ticket
 *  - 200 cancels an 'available' ticket
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  // Drizzle select chain: db.select().from(x).where(y).limit(n)
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  // Drizzle update chain: db.update(x).set(y).where(z).returning()
  const returningMock = vi.fn().mockResolvedValue([]);
  const updateWhereMock = vi.fn(() => ({ returning: returningMock }));
  const setMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  const requireAuthMock = vi.fn();
  const isEventOrganizerMock = vi.fn();

  return {
    whereMock,
    fromMock,
    selectMock,
    returningMock,
    updateWhereMock,
    setMock,
    updateMock,
    requireAuthMock,
    isEventOrganizerMock,
  };
});

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: mocks.selectMock,
    update: mocks.updateMock,
  },
  tickets: { id: 'col_id', eventId: 'col_eventId', status: 'col_status' },
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string | null; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@/src/lib/organizer', () => ({
  isEventOrganizer: mocks.isEventOrganizerMock,
}));

// ─── Subject ────────────────────────────────────────────────────────────────

import { POST } from '../../app/api/events/[id]/tickets/[ticketId]/cancel/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

const ROUTE_PARAMS = { params: Promise.resolve({ id: 'evt_1', ticketId: 'tkt_1' }) };

function makeRequest(): Request {
  return new Request('https://events.test/api/events/evt_1/tickets/tkt_1/cancel', {
    method: 'POST',
    headers: { cookie: 'session=abc' },
  });
}

function nextSelect(rows: unknown[]): void {
  const p = Promise.resolve(rows) as any;
  p.limit = vi.fn().mockResolvedValue(rows);
  mocks.whereMock.mockImplementationOnce(() => p);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/events/[id]/tickets/[ticketId]/cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.whereMock.mockReset();
    mocks.returningMock.mockResolvedValue([]);
    mocks.updateWhereMock.mockImplementation(() => ({ returning: mocks.returningMock }));

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
    expect(mocks.selectMock).not.toHaveBeenCalled();
  });

  it('returns 404 when ticket is not found', async () => {
    nextSelect([]);
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Ticket not found' });
  });

  it('returns 400 when ticket status is "valid" (must use refund instead)', async () => {
    nextSelect([{ id: 'tkt_1', status: 'valid', eventId: 'evt_1' }]);
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('valid') });
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when ticket status is "refunded"', async () => {
    nextSelect([{ id: 'tkt_1', status: 'refunded', eventId: 'evt_1' }]);
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(400);
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('cancels a held ticket and returns the updated ticket', async () => {
    const heldTicket = { id: 'tkt_1', status: 'held', eventId: 'evt_1', heldBy: 'did:buyer' };
    const cancelledTicket = { ...heldTicket, status: 'cancelled', heldBy: null, heldUntil: null };
    nextSelect([heldTicket]);
    mocks.returningMock.mockResolvedValueOnce([cancelledTicket]);

    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket.status).toBe('cancelled');
    expect(body.ticket.heldBy).toBeNull();

    // Verify the update set the right fields
    expect(mocks.setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled', heldBy: null, heldUntil: null })
    );
  });

  it('cancels an available ticket', async () => {
    const availableTicket = { id: 'tkt_1', status: 'available', eventId: 'evt_1', heldBy: null };
    nextSelect([availableTicket]);
    mocks.returningMock.mockResolvedValueOnce([{ ...availableTicket, status: 'cancelled' }]);

    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).ticket.status).toBe('cancelled');
  });
});
