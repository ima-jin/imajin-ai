/**
 * Tests for apps/events/app/api/events/[id]/tickets/[ticketId]/refund/route.ts
 *
 * This is the primary user-facing refund action (Guest List → Refund button).
 * The route branches between Stripe, e-transfer, and free tickets, and calls
 * the kernel pay service for Stripe payments.
 *
 * Cases:
 *  - Stripe ticket: pay service succeeds → 200, status 'refunded'
 *  - Stripe ticket: pay service fails → 502, ticket unchanged
 *  - E-transfer ticket → 200, manualRefundRequired + status 'refund_pending'
 *  - Free ticket (pricePaid=0) → 200, no pay service call, status 'refunded'
 *  - Ticket not in 'valid' status → 400
 *  - Ticket not found → 404
 *  - Event not found → 404
 *  - Non-organizer → 403
 *  - Unauthenticated → 401
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  // Raw postgres client (getClient) — all raw SQL goes through this one mock.
  // It acts as a tagged template literal: sqlMock`SELECT...` = sqlMock([...], ...values)
  const sqlMock = vi.fn().mockResolvedValue([]);

  // Drizzle select chain: db.select().from(x).where(y).limit(n)
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  // Drizzle update chain: db.update(x).set(y).where(z).catch(fn)
  const updateWhereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  const requireAuthMock = vi.fn();
  const getEmailForDidMock = vi.fn().mockResolvedValue(null);
  const isEventOrganizerMock = vi.fn();
  const publishMock = vi.fn().mockResolvedValue(undefined);
  const fetchMock = vi.fn();

  return {
    sqlMock,
    whereMock,
    fromMock,
    selectMock,
    updateWhereMock,
    setMock,
    updateMock,
    requireAuthMock,
    getEmailForDidMock,
    isEventOrganizerMock,
    publishMock,
    fetchMock,
  };
});

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

vi.mock('@imajin/db', () => ({
  getClient: () => mocks.sqlMock,
}));

vi.mock('@/src/db', () => ({
  db: {
    select: mocks.selectMock,
    update: mocks.updateMock,
  },
  events: { id: 'col_id', title: 'col_title' },
  ticketTypes: { id: 'col_ttId', sold: 'col_sold' },
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
  getEmailForDid: mocks.getEmailForDidMock,
}));

vi.mock('@/src/lib/organizer', () => ({
  isEventOrganizer: mocks.isEventOrganizerMock,
}));

vi.mock('@imajin/bus', () => ({
  publish: mocks.publishMock,
}));

vi.mock('@imajin/config', () => ({
  eventUrl: () => 'https://events.test/e/evt_1',
}));

// ─── Subject ────────────────────────────────────────────────────────────────

import { POST } from '../../app/api/events/[id]/tickets/[ticketId]/refund/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(): Request {
  return new Request('https://events.test/api/events/evt_1/tickets/tkt_1/refund', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: 'session=abc' },
  });
}

const ROUTE_PARAMS = { params: Promise.resolve({ id: 'evt_1', ticketId: 'tkt_1' }) };

/** Queue a Drizzle select result (event lookup) for the next whereMock call. */
function nextDrizzleSelect(rows: unknown[]): void {
  const p = Promise.resolve(rows) as any;
  p.limit = vi.fn().mockResolvedValue(rows);
  mocks.whereMock.mockImplementationOnce(() => p);
}

/** Queue a raw SQL result for the next sqlMock call. */
function nextSql(rows: unknown[]): void {
  mocks.sqlMock.mockResolvedValueOnce(rows);
}

const BASE_EVENT = {
  id: 'evt_1',
  title: 'Test Event',
  imageUrl: null,
  isVirtual: false,
  venue: null,
};

const STRIPE_TICKET = {
  id: 'tkt_1',
  status: 'valid',
  price_paid: 27500,          // cents
  payment_id: 'pi_test_stripe',
  payment_method: 'stripe',
  ticket_type_id: 'tkt_type_1',
  owner_did: 'did:imajin:buyer',
  currency: 'CAD',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/events/[id]/tickets/[ticketId]/refund', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.whereMock.mockReset();
    mocks.sqlMock.mockReset();

    // Defaults restored after reset
    mocks.sqlMock.mockResolvedValue([]);
    mocks.updateWhereMock.mockResolvedValue(undefined);
    mocks.publishMock.mockResolvedValue(undefined);
    mocks.getEmailForDidMock.mockResolvedValue('buyer@test.com');

    process.env.PAY_SERVICE_URL = 'http://kernel-test';
    process.env.PAY_SERVICE_API_KEY = 'service-key';

    mocks.requireAuthMock.mockResolvedValue({
      identity: { id: 'did:imajin:organizer', actingAs: null },
    });
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: true });

    vi.stubGlobal('fetch', mocks.fetchMock);
    mocks.fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
  });

  it('returns 401 when auth fails', async () => {
    mocks.requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(401);
  });

  it('returns 404 when event is not found', async () => {
    nextDrizzleSelect([]);  // event not found
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Event not found' });
  });

  it('returns 403 when caller is not an organizer', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: false });
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(403);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 when ticket is not found', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    nextSql([]);  // ticket SELECT → empty
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Ticket not found' });
  });

  it('returns 400 when ticket is not valid (e.g. already refunded)', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    nextSql([{ ...STRIPE_TICKET, status: 'refunded' }]);
    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Only valid tickets can be refunded' });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 502 when the pay service fails (Stripe ticket)', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    nextSql([STRIPE_TICKET]);
    mocks.fetchMock.mockResolvedValue({ ok: false, text: async () => 'Stripe error' });

    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'Payment refund failed — ticket status not changed' });

    // Ticket status must NOT have been updated
    expect(mocks.sqlMock).toHaveBeenCalledOnce(); // only the SELECT, no UPDATE
  });

  it('refunds a Stripe ticket: calls pay service and returns status refunded', async () => {
    nextDrizzleSelect([BASE_EVENT]);
    nextSql([STRIPE_TICKET]);                  // (1) SELECT ticket
    nextSql([{ id: 'tkt_1', status: 'refunded' }]); // (2) UPDATE ticket RETURNING

    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket.status).toBe('refunded');
    expect(body.manualRefundRequired).toBeUndefined();

    // Pay service called with the ticket's payment ID and price
    expect(mocks.fetchMock).toHaveBeenCalledOnce();
    const [url, init] = mocks.fetchMock.mock.calls[0];
    expect(url).toContain('/api/refund');
    const reqBody = JSON.parse(init.body);
    expect(reqBody.paymentId).toBe('pi_test_stripe');
    expect(reqBody.amount).toBe(27500);

    // Bus event published
    expect(mocks.publishMock).toHaveBeenCalledWith(
      'ticket.refunded',
      expect.objectContaining({ payload: expect.objectContaining({ manualRefundRequired: false }) })
    );
  });

  it('handles an e-transfer ticket: returns manualRefundRequired and refund_pending status', async () => {
    const etransferTicket = {
      ...STRIPE_TICKET,
      payment_method: 'etransfer',
      payment_id: null,
    };

    nextDrizzleSelect([BASE_EVENT]);
    nextSql([etransferTicket]);                         // (1) SELECT ticket
    nextSql([{ id: 'tkt_1', status: 'refund_pending' }]); // (2) UPDATE ticket RETURNING

    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket.status).toBe('refund_pending');
    expect(body.manualRefundRequired).toBe(true);
    expect(body.refundAmount).toBe('275.00');

    // No Stripe call for e-transfer
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('handles a free ticket: no pay service call, ticket directly refunded', async () => {
    const freeTicket = {
      ...STRIPE_TICKET,
      price_paid: 0,
      payment_id: null,
      payment_method: null,
    };

    nextDrizzleSelect([BASE_EVENT]);
    nextSql([freeTicket]);                             // (1) SELECT ticket
    nextSql([{ id: 'tkt_1', status: 'refunded' }]);   // (2) UPDATE ticket RETURNING

    const res = await POST(makeRequest() as any, ROUTE_PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).ticket.status).toBe('refunded');
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });
});
