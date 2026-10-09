/**
 * #2754 item 2: settlement of a payment_request from the issuer's OWN
 * `stripe.payment_intent.succeeded`. The property under test is as much what
 * it refuses to do (settle someone else's request, settle the wrong amount,
 * touch the platform ledger) as what it does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getPaymentRequestByIdMock: vi.fn(),
  getNodeDidMock: vi.fn(),
  announcePaidMock: vi.fn(),
  attestAndAnnounceMock: vi.fn(),
  warnMock: vi.fn(),
  errorMock: vi.fn(),
  updateReturning: [] as Array<Array<Record<string, unknown>>>,
  updateCalls: [] as Array<Record<string, unknown>>,
  txSelect: [] as Array<Array<Record<string, unknown>>>,
  insertCalls: [] as Array<Record<string, unknown>>,
  insertShouldFail: false,
  settlePaymentMock: vi.fn(),
  updateSet: (values: Record<string, unknown>) => {
    h.updateCalls.push(values);
    return { where: h.updateWhere };
  },
  updateWhere: () => ({ returning: h.updateReturningRows }),
  updateReturningRows: async () => h.updateReturning.shift() ?? [],
  selectWhere: () => ({ limit: h.selectLimit }),
  selectLimit: async () => h.txSelect.shift() ?? [],
  insertValues: async (values: Record<string, unknown>) => {
    if (h.insertShouldFail) throw new Error('insert failed');
    h.insertCalls.push(values);
  },
}));

// Flat fakes (hoisted into `h`) keep the drizzle chain from nesting functions four levels deep.
vi.mock('@/src/db', () => ({
  db: {
    update: () => ({ set: h.updateSet }),
    select: () => ({ from: () => ({ where: h.selectWhere }) }),
    insert: () => ({ values: h.insertValues }),
  },
  paymentRequests: { id: 'id', status: 'status' },
  transactions: { id: 'id', rail: 'rail', externalRef: 'externalRef' },
}));
vi.mock('drizzle-orm', () => ({
  and: (...c: unknown[]) => ({ and: c }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: h.warnMock, error: h.errorMock }) }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: h.getNodeDidMock }));
vi.mock('../service', () => ({ getPaymentRequestById: h.getPaymentRequestByIdMock }));
vi.mock('../checkout', () => ({
  OPEN_STATUSES: ['issued', 'emt_pending'],
  isOpenStatus: (status: string) => status === 'issued' || status === 'emt_pending',
  announcePaymentRequestPaid: h.announcePaidMock,
  attestAndAnnounceStripeSettled: h.attestAndAnnounceMock,
}));
// The ledger settlement must NEVER be reached from this module.
vi.mock('@/src/lib/pay/settle-core', () => ({ settlePayment: h.settlePaymentMock }));

import { settlePaymentRequestFromByoStripe } from '../byo-settlement';

const OWNER = 'did:imajin:imajin-inc';
const REQUEST = {
  id: 'pr_1',
  issuerDid: OWNER,
  recipientDid: 'did:imajin:customer',
  paidByDid: null,
  status: 'issued',
  currency: 'CAD',
  totalAmount: 226_000,
  subtotalAmount: 200_000,
  settlementRef: null,
  fairManifest: { chain: [{ did: OWNER, role: 'seller', share: 1 }], fees: [] },
};
const EVENT = { ownerDid: OWNER, paymentRequestId: 'pr_1', paymentIntentId: 'pi_1', amount: 226_000, currency: 'CAD' };

beforeEach(() => {
  h.getPaymentRequestByIdMock.mockReset().mockResolvedValue(REQUEST);
  h.getNodeDidMock.mockReset().mockResolvedValue('did:imajin:node');
  h.announcePaidMock.mockReset();
  h.attestAndAnnounceMock.mockReset().mockResolvedValue(undefined);
  h.warnMock.mockReset();
  h.errorMock.mockReset();
  h.updateReturning.length = 0;
  h.updateCalls.length = 0;
  h.txSelect.length = 0;
  h.insertCalls.length = 0;
  h.insertShouldFail = false;
  h.settlePaymentMock.mockReset();
});

describe('settlePaymentRequestFromByoStripe', () => {
  it('settles the issuer\'s own request: paid, a BYO-rail transaction row, announced and attested', async () => {
    h.updateReturning.push([{ ...REQUEST, status: 'paid' }]);

    const outcome = await settlePaymentRequestFromByoStripe(EVENT);

    expect(outcome).toMatchObject({ settled: true, paymentRequest: { id: 'pr_1', status: 'paid' } });

    // The guarded transition, with a settlement ref that says whose Stripe account it was.
    expect(h.updateCalls).toHaveLength(1);
    expect(h.updateCalls[0]).toMatchObject({
      status: 'paid',
      settlementRef: { method: 'stripe', payment_intent_id: 'pi_1', byo: true, settled_at: expect.any(String) },
    });

    // A completed transaction row on the BYO rail, keyed by the PaymentIntent.
    expect(h.insertCalls).toHaveLength(1);
    expect(h.insertCalls[0]).toMatchObject({
      rail: 'stripe-byo',
      externalRef: 'pi_1',
      status: 'completed',
      toDid: OWNER,
      service: 'payment_request',
      amount: '2260',
      currency: 'CAD',
    });

    expect(h.announcePaidMock).toHaveBeenCalledOnce();
    expect(h.attestAndAnnounceMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pr_1' }),
      expect.objectContaining({ method: 'stripe', byo: true }),
      'did:imajin:node',
    );
  });

  it('NEVER runs the platform ledger settlement — the platform balance does not move', async () => {
    h.updateReturning.push([{ ...REQUEST, status: 'paid' }]);

    await settlePaymentRequestFromByoStripe(EVENT);

    expect(h.settlePaymentMock).not.toHaveBeenCalled();
  });

  it('records the platform fee on the transaction\'s manifest as an explicit 0 — and leaves the signed original untouched', async () => {
    h.updateReturning.push([{ ...REQUEST, status: 'paid' }]);

    await settlePaymentRequestFromByoStripe(EVENT);

    const recorded = h.insertCalls[0];
    expect(recorded.fairManifest).toEqual({ ...REQUEST.fairManifest, platformFee: { rateBps: 0, amountCents: 0, reason: 'byo_no_platform_fee' } });
    expect(recorded.metadata).toMatchObject({ payment_request_id: 'pr_1', payment_intent_id: 'pi_1', platform_fee_cents: 0 });
    expect(REQUEST.fairManifest).not.toHaveProperty('platformFee');
  });

  it('settles a request the payer had moved to emt_pending (card still works then)', async () => {
    h.getPaymentRequestByIdMock.mockResolvedValue({ ...REQUEST, status: 'emt_pending' });
    h.updateReturning.push([{ ...REQUEST, status: 'paid' }]);

    expect(await settlePaymentRequestFromByoStripe(EVENT)).toMatchObject({ settled: true });
  });

  describe('refuses — and writes nothing', () => {
    it('an unknown payment_request', async () => {
      h.getPaymentRequestByIdMock.mockResolvedValue(null);

      expect(await settlePaymentRequestFromByoStripe(EVENT)).toEqual({ settled: false, reason: 'not_found' });
      expect(h.updateCalls).toHaveLength(0);
      expect(h.insertCalls).toHaveLength(0);
    });

    it('a request issued by SOMEONE ELSE — an owner can only ever settle their own', async () => {
      h.getPaymentRequestByIdMock.mockResolvedValue({ ...REQUEST, issuerDid: 'did:imajin:someone-else' });

      expect(await settlePaymentRequestFromByoStripe(EVENT)).toEqual({ settled: false, reason: 'not_issuer' });
      expect(h.updateCalls).toHaveLength(0);
      expect(h.insertCalls).toHaveLength(0);
      expect(h.attestAndAnnounceMock).not.toHaveBeenCalled();
      expect(h.warnMock).toHaveBeenCalled();
    });

    it.each([
      ['a short payment', { amount: 100 }],
      ['an overpayment', { amount: 999_999 }],
      ['the wrong currency', { currency: 'USD' }],
    ])('%s', async (_label, override) => {
      expect(await settlePaymentRequestFromByoStripe({ ...EVENT, ...override })).toEqual({ settled: false, reason: 'amount_mismatch' });
      expect(h.updateCalls).toHaveLength(0);
      expect(h.insertCalls).toHaveLength(0);
    });
  });

  describe('idempotency', () => {
    it('a webhook replay on an already-paid request is a silent no-op', async () => {
      h.getPaymentRequestByIdMock.mockResolvedValue({
        ...REQUEST,
        status: 'paid',
        settlementRef: { method: 'stripe', byo: true, payment_intent_id: 'pi_1' },
      });

      expect(await settlePaymentRequestFromByoStripe(EVENT)).toEqual({ settled: false, reason: 'not_open' });
      expect(h.updateCalls).toHaveLength(0);
      expect(h.insertCalls).toHaveLength(0);
      expect(h.errorMock).not.toHaveBeenCalled();
    });

    it.each([
      ['paid by e-Transfer first', { status: 'paid', settlementRef: { method: 'emt' } }],
      ['settled manually', { status: 'settled_manual', settlementRef: { method: 'manual' } }],
      ['paid by a DIFFERENT intent', { status: 'paid', settlementRef: { method: 'stripe', byo: true, payment_intent_id: 'pi_other' } }],
    ])('a payment landing on a request already %s is not settled again, and is flagged for refund review', async (_label, override) => {
      h.getPaymentRequestByIdMock.mockResolvedValue({ ...REQUEST, ...override });

      expect(await settlePaymentRequestFromByoStripe(EVENT)).toEqual({ settled: false, reason: 'not_open' });
      expect(h.updateCalls).toHaveLength(0);
      expect(h.errorMock).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: 'pi_1' }), expect.stringContaining('refund'));
    });

    it('losing the guarded transition to a concurrent settlement writes nothing', async () => {
      h.updateReturning.push([]); // the compare-and-swap matched no row

      expect(await settlePaymentRequestFromByoStripe(EVENT)).toEqual({ settled: false, reason: 'lost_race' });
      expect(h.insertCalls).toHaveLength(0);
      expect(h.announcePaidMock).not.toHaveBeenCalled();
      expect(h.attestAndAnnounceMock).not.toHaveBeenCalled();
    });

    it('does not insert a second transaction row for the same PaymentIntent', async () => {
      h.updateReturning.push([{ ...REQUEST, status: 'paid' }]);
      h.txSelect.push([{ id: 'tx_existing' }]);

      expect(await settlePaymentRequestFromByoStripe(EVENT)).toMatchObject({ settled: true });
      expect(h.insertCalls).toHaveLength(0);
    });
  });

  it('a failed transaction-row write does not strand the paid request: it is still announced and attested', async () => {
    h.updateReturning.push([{ ...REQUEST, status: 'paid' }]);
    h.insertShouldFail = true;

    const outcome = await settlePaymentRequestFromByoStripe(EVENT);

    expect(outcome).toMatchObject({ settled: true });
    expect(h.errorMock).toHaveBeenCalledWith(expect.objectContaining({ paymentRequestId: 'pr_1' }), expect.stringContaining('transaction row'));
    expect(h.announcePaidMock).toHaveBeenCalledOnce();
    expect(h.attestAndAnnounceMock).toHaveBeenCalledOnce();
  });
});
