/**
 * Tests for apps/events/app/api/orders/[id]/refund/route.ts
 *
 * Covers the new order-level refund endpoint introduced in #949:
 *  - Successful full-order Stripe refund → tickets marked 'refunded', order updated
 *  - Already-refunded order → 400
 *  - Pay service failure → 502, ticket statuses unchanged
 *  - No refundable tickets → 400
 *  - Non-organizer caller → 403
 *  - Free/e-transfer orders skip the Stripe call
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  // Drizzle select chain
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  // Drizzle update chain
  const updateWhereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  // Drizzle insert — not used by this route but present in db mock
  const insertValuesMock = vi.fn().mockResolvedValue(undefined);
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));

  const requireAuthMock = vi.fn();
  const isEventOrganizerMock = vi.fn();
  const publishMock = vi.fn().mockResolvedValue(undefined);
  const fetchMock = vi.fn();

  return {
    whereMock,
    fromMock,
    selectMock,
    updateWhereMock,
    setMock,
    updateMock,
    insertValuesMock,
    insertMock,
    requireAuthMock,
    isEventOrganizerMock,
    publishMock,
    fetchMock,
  };
});

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: mocks.selectMock,
    update: mocks.updateMock,
    insert: mocks.insertMock,
  },
  orders: { id: 'col_id', status: 'col_status', eventId: 'col_eventId', buyerDid: 'col_buyerDid' },
  tickets: { id: 'col_tid', orderId: 'col_orderId', status: 'col_status', ticketTypeId: 'col_ttId' },
  ticketTypes: { id: 'col_ttId', sold: 'col_sold' },
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

import { POST } from '../../app/api/orders/[id]/refund/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(): Request {
  return new Request('https://events.test/api/orders/ord_test_1/refund', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: 'session=abc' },
  });
}

function nextSelect(rows: unknown[]): void {
  const p = Promise.resolve(rows) as any;
  p.limit = vi.fn().mockResolvedValue(rows);
  mocks.whereMock.mockImplementationOnce(() => p);
}

const BASE_ORDER = {
  id: 'ord_test_1',
  eventId: 'evt_test_1',
  buyerDid: 'did:imajin:buyer',
  amountTotal: 55000,  // $550 in cents
  currency: 'CAD',
  paymentMethod: 'stripe',
  paymentId: 'pi_test_intent',
  stripeSessionId: 'cs_test_session',
  status: 'completed',
  purchasedAt: new Date().toISOString(),
  metadata: {},
};

const BASE_TICKETS = [
  {
    id: 'tkt_1',
    orderId: 'ord_test_1',
    eventId: 'evt_test_1',
    ticketTypeId: 'tkt_type_1',
    status: 'valid',
    pricePaid: 27500,
    currency: 'CAD',
    ownerDid: 'did:imajin:buyer',
    paymentMethod: 'stripe',
    paymentId: 'pi_test_intent',
  },
  {
    id: 'tkt_2',
    orderId: 'ord_test_1',
    eventId: 'evt_test_1',
    ticketTypeId: 'tkt_type_1',
    status: 'valid',
    pricePaid: 27500,
    currency: 'CAD',
    ownerDid: 'did:imajin:buyer',
    paymentMethod: 'stripe',
    paymentId: 'pi_test_intent',
  },
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/orders/[id]/refund (#949)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset whereMock to clear leftover one-time implementations from failed tests.
    mocks.whereMock.mockReset();
    mocks.updateWhereMock.mockResolvedValue(undefined);
    process.env.PAY_SERVICE_URL = 'http://kernel-test';
    process.env.PAY_SERVICE_API_KEY = 'service-key';

    mocks.requireAuthMock.mockResolvedValue({
      identity: { id: 'did:imajin:organizer', actingAs: null },
    });
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: true });
    vi.stubGlobal('fetch', mocks.fetchMock);
    mocks.fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
    mocks.publishMock.mockResolvedValue(undefined);
  });

  it('returns 401 when auth fails', async () => {
    mocks.requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    const res = await POST(makeRequest() as any, { params: Promise.resolve({ id: 'ord_test_1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when order is not found', async () => {
    nextSelect([]);  // no order

    const res = await POST(makeRequest() as any, { params: Promise.resolve({ id: 'ord_missing' }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it('returns 400 when order is already refunded', async () => {
    nextSelect([{ ...BASE_ORDER, status: 'refunded' }]);

    const res = await POST(makeRequest() as any, { params: Promise.resolve({ id: 'ord_test_1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Order already refunded');
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 403 when caller is not an organizer', async () => {
    nextSelect([BASE_ORDER]);
    mocks.isEventOrganizerMock.mockResolvedValue({ authorized: false });

    const res = await POST(makeRequest() as any, { params: Promise.resolve({ id: 'ord_test_1' }) });
    expect(res.status).toBe(403);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the order has no refundable tickets', async () => {
    nextSelect([BASE_ORDER]);   // order found
    nextSelect([]);             // no valid/used tickets

    const res = await POST(makeRequest() as any, { params: Promise.resolve({ id: 'ord_test_1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no refundable/i);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 502 and leaves tickets unchanged when pay service fails', async () => {
    nextSelect([BASE_ORDER]);
    nextSelect(BASE_TICKETS);
    mocks.fetchMock.mockResolvedValue({
      ok: false,
      text: async () => 'Stripe error',
    });

    const res = await POST(makeRequest() as any, { params: Promise.resolve({ id: 'ord_test_1' }) });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/payment refund failed/i);

    // Ticket status must NOT have been updated
    expect(mocks.setMock).not.toHaveBeenCalledWith({ status: 'refunded' });
  });

  it('refunds all tickets and updates order status on success', async () => {
    nextSelect([BASE_ORDER]);
    nextSelect(BASE_TICKETS);

    const res = await POST(makeRequest() as any, { params: Promise.resolve({ id: 'ord_test_1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orderId).toBe('ord_test_1');
    expect(body.refundedTickets).toBe(2);
    expect(body.status).toBe('refunded');

    // Pay service was called with the order's paymentId
    expect(mocks.fetchMock).toHaveBeenCalledOnce();
    const [url, init] = mocks.fetchMock.mock.calls[0];
    expect(url).toContain('/api/refund');
    const reqBody = JSON.parse(init.body);
    expect(reqBody.paymentId).toBe('pi_test_intent');

    // Tickets and order both updated to 'refunded'
    const statusUpdates = mocks.setMock.mock.calls.map((c: any[]) => c[0].status);
    expect(statusUpdates.filter((s: string) => s === 'refunded').length).toBeGreaterThanOrEqual(2);

    // Bus event published
    expect(mocks.publishMock).toHaveBeenCalledOnce();
    const [eventType] = mocks.publishMock.mock.calls[0];
    expect(eventType).toBe('order.refunded');
  });

  it('skips Stripe call for free/e-transfer orders and still marks tickets', async () => {
    const freeOrder = { ...BASE_ORDER, paymentMethod: 'etransfer', paymentId: null };
    nextSelect([freeOrder]);
    nextSelect(BASE_TICKETS);

    const res = await POST(makeRequest() as any, { params: Promise.resolve({ id: 'ord_test_1' }) });
    expect(res.status).toBe(200);

    // No fetch call for non-Stripe orders
    expect(mocks.fetchMock).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.refundedTickets).toBe(2);
  });
});
