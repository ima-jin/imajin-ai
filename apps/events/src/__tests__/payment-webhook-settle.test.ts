/**
 * Tests for apps/events/app/api/webhook/payment/route.ts — the #2739 wiring:
 * on a completed checkout events settles through the pay service with its own
 * app token (`settleCompletedOrder`) instead of publishing `order.completed`
 * for the kernel-only bus `settle` reactor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.WEBHOOK_SECRET = 'test-webhook-secret';
  const selectQueue: unknown[][] = [];
  return {
    selectQueue,
    settleCompletedOrder: vi.fn(),
    createOrderWithTickets: vi.fn(),
    busPublish: vi.fn(),
    publishConfirmationEmails: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('@imajin/logger', () => ({
  withLogger: (_name: string, handler: (req: unknown, ctx: unknown) => unknown) => (req: unknown) =>
    handler(req, { log: mocks.log }),
  createLogger: () => mocks.log,
}));
vi.mock('@imajin/bus', () => ({ publish: mocks.busPublish }));
vi.mock('@imajin/config', () => ({
  eventRegisterUrl: (base: string, eventId: string, ticketId: string) => `${base}/e/${eventId}/register/${ticketId}`,
  eventMyTicketsUrl: (base: string, eventId: string) => `${base}/e/${eventId}/tickets`,
  buildPublicUrlAbsolute: (name: string) => `https://${name}.test`,
}));
vi.mock('@/src/db', () => {
  // db.select().from().where() is awaited directly in some places and `.limit()`-ed in others.
  const where = () => {
    const result = Promise.resolve(mocks.selectQueue.shift() ?? []);
    return Object.assign(result, { limit: () => result });
  };
  return {
    db: {
      select: () => ({ from: () => ({ where }) }),
      execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
      update: () => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
    },
    events: {},
    ticketTypes: {},
    tickets: {},
    orders: {},
  };
});
vi.mock('@/src/lib/contact-email', () => ({ backfillContactEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/checkout-common', () => ({ createOrderWithTickets: mocks.createOrderWithTickets }));
vi.mock('@/src/lib/pay-settle', () => ({ settleCompletedOrder: mocks.settleCompletedOrder }));
vi.mock('@/src/lib/webhook-payment-helpers', () => ({
  parseCartFromMetadata: () => [{ ticketTypeId: 'tt_1', quantity: 2 }],
  createOnboardToken: vi.fn().mockResolvedValue('onboard-token'),
  syncBuyerToEventChat: vi.fn().mockResolvedValue(undefined),
  publishConfirmationEmails: mocks.publishConfirmationEmails,
}));

import { POST } from '../../app/api/webhook/payment/route';

const ORGANIZER = 'did:imajin:organizer';
const FAIR = { chain: [{ did: ORGANIZER, role: 'seller', share: 1 }] };
const EVENT = { id: 'evt_1', did: 'did:imajin:evt_1', title: 'Summer Fair', creatorDid: ORGANIZER, privateKey: 'x', metadata: { fair: FAIR } };
const TICKET_TYPE = { id: 'tt_1', name: 'GA', eventId: 'evt_1' };

const PAYLOAD = {
  type: 'checkout.completed',
  sessionId: 'cs_1',
  paymentId: 'pi_1',
  customerEmail: 'buyer@example.test',
  customerName: 'Buyer',
  amountTotal: 5000,
  currency: 'cad',
  metadata: { eventId: 'evt_1', eventDid: 'did:imajin:evt_1', buyerDid: 'did:imajin:buyer' },
};

function request(body: unknown, secret = 'test-webhook-secret') {
  return { headers: new Headers({ authorization: `Bearer ${secret}` }), json: async () => body };
}

const callRoute = (body: unknown = PAYLOAD, secret?: string) =>
  (POST as unknown as (req: unknown) => Promise<Response>)(request(body, secret));

beforeEach(() => {
  vi.clearAllMocks();
  // select order inside handleCheckoutCompleted: duplicate-order check, event, ticket types, owner's soft-DID tickets.
  mocks.selectQueue.length = 0;
  mocks.selectQueue.push([], [EVENT], [TICKET_TYPE], []);
  mocks.createOrderWithTickets.mockResolvedValue({
    tickets: [{ id: 'tkt_1', registrationStatus: 'not_required', pricePaid: 2500 }, { id: 'tkt_2', registrationStatus: 'not_required', pricePaid: 2500 }],
    order: { id: 'ord_1' },
  });
  mocks.settleCompletedOrder.mockResolvedValue({ status: 'settled', alreadySettled: false, manifest: { chain: [] } });
  mocks.busPublish.mockResolvedValue(undefined);
  mocks.publishConfirmationEmails.mockResolvedValue(undefined);
});

describe('POST /api/webhook/payment — settle via events’ app token (#2739)', () => {
  it('settles the completed order through the pay service with the order, session and .fair manifest', async () => {
    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mocks.settleCompletedOrder).toHaveBeenCalledTimes(1);
    expect(mocks.settleCompletedOrder).toHaveBeenCalledWith({
      sessionId: 'cs_1',
      orderId: 'ord_1',
      eventId: 'evt_1',
      buyerDid: 'did:imajin:buyer',
      creatorDid: ORGANIZER,
      amountCents: 5000,
      currency: 'cad',
      fairManifest: FAIR,
      metadata: {
        orderId: 'ord_1',
        ticketIds: ['tkt_1', 'tkt_2'],
        ticketTypeId: 'tt_1',
        stripeSessionId: 'cs_1',
        eventId: 'evt_1',
      },
      log: mocks.log,
    });
  });

  it('no longer publishes order.completed on the bus (that reactor only settles inside the kernel process)', async () => {
    await callRoute();

    const published = mocks.busPublish.mock.calls.map(([type]) => type);
    expect(published).not.toContain('order.completed');
    expect(published).toContain('ticket.purchased');
  });

  it('passes a null manifest through for an event with no .fair chain', async () => {
    mocks.selectQueue.length = 0;
    mocks.selectQueue.push([], [{ ...EVENT, metadata: {} }], [TICKET_TYPE], []);

    await callRoute();

    expect(mocks.settleCompletedOrder).toHaveBeenCalledWith(expect.objectContaining({ fairManifest: null }));
  });

  it('keeps the order and acknowledges the webhook when settlement throws (non-fatal)', async () => {
    mocks.settleCompletedOrder.mockRejectedValue(new Error('unexpected'));

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(mocks.log.error).toHaveBeenCalledWith({ err: 'Error: unexpected' }, expect.stringContaining('[settle]'));
    // The confirmation email still goes out after a settlement failure.
    expect(mocks.publishConfirmationEmails).toHaveBeenCalledTimes(1);
  });

  it('rejects a webhook without the shared secret before doing anything', async () => {
    const res = await callRoute(PAYLOAD, 'wrong-secret');

    expect(res.status).toBe(401);
    expect(mocks.settleCompletedOrder).not.toHaveBeenCalled();
  });
});
