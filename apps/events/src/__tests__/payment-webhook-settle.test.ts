/**
 * Tests for apps/events/app/api/webhook/payment/route.ts — the #2739 wiring:
 * on a completed checkout events settles through the pay service with its own
 * app token (`settleCompletedOrder`) instead of publishing `order.completed`
 * for the kernel-only bus `settle` reactor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { discoveryResponse, EVENTS_APP_DID, signedWebhook, TEST_AUTH_URL } from './signed-webhook-support';

const mocks = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  return {
    selectQueue,
    settleCompletedOrder: vi.fn(),
    createOrderWithTickets: vi.fn(),
    busPublish: vi.fn(),
    publishConfirmationEmails: vi.fn(),
    select: vi.fn(),
    execute: vi.fn(),
    update: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});
vi.mock('@imajin/auth/kernel-webhook', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@imajin/auth/kernel-webhook')>();
  // Exercise actual verification; isolate only public pin persistence from the filesystem.
  const pinStore = {
    load: async () => null, save: async () => undefined,
    withLock: async <T>(_namespace: string, operation: () => Promise<T>): Promise<T> => operation(),
  };
  return { ...sdk, verifyKernelWebhook: (req: Request, opts: Parameters<typeof sdk.verifyKernelWebhook>[1]) =>
    sdk.verifyKernelWebhook(req, { ...opts, pinStore }) };
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
      select: mocks.select.mockImplementation(() => ({ from: () => ({ where }) })),
      execute: mocks.execute.mockResolvedValue({ rowCount: 1 }),
      update: mocks.update.mockImplementation(() => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) })),
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
  transactionId: 'tx_1',
  customerEmail: 'buyer@example.test',
  customerName: 'Buyer',
  amountTotal: 5000,
  currency: 'cad',
  metadata: { eventId: 'evt_1', eventDid: 'did:imajin:evt_1', buyerDid: 'did:imajin:buyer' },
};

const callRequest = (request: Request) => (POST as unknown as (req: Request) => Promise<Response>)(request);
const callRoute = (body: unknown = PAYLOAD) => callRequest(signedWebhook('/api/webhook/payment', body));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('IMAJIN_APP_DID', EVENTS_APP_DID);
  vi.stubEnv('AUTH_SERVICE_URL', TEST_AUTH_URL);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => discoveryResponse()));
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/webhook/payment — settle via events’ app token (#2739)', () => {
  it('settles the completed order through the pay service with the order, session and .fair manifest', async () => {
    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mocks.settleCompletedOrder).toHaveBeenCalledTimes(1);
    expect(mocks.settleCompletedOrder).toHaveBeenCalledWith({
      sessionId: 'cs_1',
      transactionId: 'tx_1',
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

  it('passes no transactionId through when the pay webhook does not carry one (settle then skips loudly)', async () => {
    const { transactionId: _omitted, ...withoutTransactionId } = PAYLOAD;

    const res = await callRoute(withoutTransactionId);

    expect(res.status).toBe(200);
    expect(mocks.settleCompletedOrder).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'cs_1', transactionId: undefined }));
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

  it.each(['legacy', 'audience', 'signature', 'tamper'])('rejects %s before any database or business effects', async (kind) => {
    let request = signedWebhook('/api/webhook/payment', PAYLOAD,
      kind === 'audience' ? 'did:imajin:another-test-app' : EVENTS_APP_DID);
    if (kind === 'legacy') request = new Request(request.url, {
      method: 'POST', body: JSON.stringify(PAYLOAD), headers: { authorization: 'Bearer fake-legacy-test-only' },
    });
    if (kind === 'signature') request.headers.set('x-kernel-signature', '00'.repeat(64));
    if (kind === 'tamper') request = new Request(request.url, {
      method: 'POST', headers: request.headers, body: JSON.stringify({ ...PAYLOAD, amountTotal: 1 }),
    });
    const res = await callRequest(request);
    expect(res.status).toBe(401);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
    expect(mocks.settleCompletedOrder).not.toHaveBeenCalled();
    if (kind === 'audience' || kind === 'legacy') expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects replay before repeating any database effects', async () => {
    const request = signedWebhook('/api/webhook/payment', PAYLOAD);
    expect((await callRequest(request.clone())).status).toBe(200);
    vi.clearAllMocks();
    const response = await callRequest(request.clone());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'REPLAY' });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
  });
});
