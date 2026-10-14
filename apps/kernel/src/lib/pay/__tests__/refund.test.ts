import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  where: vi.fn(), limit: vi.fn(), orderBy: vi.fn(), keys: vi.fn(), session: vi.fn(), refund: vi.fn(), client: vi.fn(),
}));
vi.mock('@/src/db', async () => ({
  db: { select: () => ({ from: () => ({ where: h.where }) }) },
  transactions: (await import('@/src/db/schemas/pay')).transactions,
}));
vi.mock('../rails/stripe-keys', () => ({
  resolveDidStripeKeys: h.keys,
  SellerNoCardRailError: class extends Error { code = 'SELLER_NO_CARD_RAIL'; },
}));
vi.mock('../providers/seller-pledge-refund', () => ({
  sellerSessionPaymentIntent: h.session, sellerPledgeRefundClient: h.client,
}));
import { resolveOriginalTransaction, refundSellerPayment } from '../refund';
import { SellerNoCardRailError } from '../rails/stripe-keys';
import { renderWhere } from './mock-drizzle-table';

const log = { error: vi.fn() };
const row = { id: 'tx_1', appDid: 'did:imajin:app', rail: 'stripe-byo', toDid: 'did:imajin:seller',
  externalRef: 'cs_test', status: 'completed', settledAt: null, metadata: {} };
function next(rows: unknown[]) {
  const result = Object.assign(Promise.resolve(rows), {
    limit: (count: number) => { h.limit(count); return Promise.resolve(rows.slice(0, count)); },
    orderBy: (...args: unknown[]) => { h.orderBy(...args); return result; },
  });
  h.where.mockReturnValueOnce(result);
}
beforeEach(() => {
  vi.clearAllMocks();
  h.where.mockReset();
  h.keys.mockResolvedValue({ secretKey: 'test-only-seller-key' });
  h.client.mockReturnValue({ refunds: { create: h.refund } });
  h.session.mockResolvedValue('pi_test');
  h.refund.mockResolvedValue({ id: 're_test', amount: 500, status: 'succeeded' });
});

describe('seller refund resolution', () => {
  it('resolves the app-owned verified settlement PI with no key reads or Stripe requests', async () => {
    const settled = { ...row, settledAt: new Date(), metadata: { settledPaymentIntentId: 'pi_test' } };
    next([]); next([settled]);
    expect(await resolveOriginalTransaction('pi_test', log, row.appDid)).toEqual(settled);
    const predicate = renderWhere(h.where.mock.calls[1][0]);
    expect(predicate.params).toEqual([row.appDid, 'stripe-byo', 'completed', 'partially_refunded', 'pi_test']);
    expect(predicate.sql).toContain('"settled_at" is not null');
    expect(predicate.sql).toContain("->>'settledPaymentIntentId'");
    expect(h.limit.mock.calls).toEqual([[1], [1]]);
    expect(h.keys).not.toHaveBeenCalled();
    expect(h.session).not.toHaveBeenCalled();
  });

  it('bounds SQL-selected legacy candidates and orders newest first with a stable id tie-breaker', async () => {
    next([]); next([]); next([row]);
    await resolveOriginalTransaction('pi_test', log, row.appDid);
    const predicate = renderWhere(h.where.mock.calls[2][0]);
    expect(predicate.params).toEqual([row.appDid, 'stripe-byo', 'completed', 'partially_refunded', 'cs_']);
    expect(predicate.sql).toContain('left(');
    expect(h.limit.mock.calls).toEqual([[1], [1], [25]]);
    expect(h.orderBy).toHaveBeenCalledTimes(1);
    expect(renderWhere(h.orderBy.mock.calls[0][0]).sql).toContain('"created_at" desc');
    expect(renderWhere(h.orderBy.mock.calls[0][1]).sql).toContain('"id" asc');
  });

  it('skips a disconnected seller and continues to a later matching seller without logging credential errors', async () => {
    const unavailable = { ...row, id: 'tx_disconnected', toDid: 'did:imajin:disconnected', externalRef: 'cs_disconnected' };
    next([]); next([]); next([unavailable, row]);
    h.keys.mockRejectedValueOnce(new Error('rk_test_fake_sensitive_error')).mockResolvedValueOnce({ secretKey: 'test-only-seller-key' });
    expect(await resolveOriginalTransaction('pi_test', log, row.appDid)).toEqual(row);
    expect(h.keys.mock.calls).toEqual([[unavailable.toDid], [row.toDid]]);
    expect(h.session).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith({ transactionId: unavailable.id }, '[refund] Seller session lookup unavailable');
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('fake_sensitive_error');
  });
  it('matches both rail namespaces directly without reading any keys', async () => {
    next([row]);
    expect(await resolveOriginalTransaction('cs_test', log, row.appDid)).toEqual(row);
    const predicate = renderWhere(h.where.mock.calls[0][0]);
    expect(predicate.params).toEqual(['stripe', 'cs_test', 'stripe-byo', 'cs_test']);
    expect(h.keys).not.toHaveBeenCalled();
  });
  it.each(['paymentIntentId', 'stripePaymentIntentId', 'settledPaymentIntentId'])('ignores spoofed %s metadata when resolving another intent', async (field) => {
    next([]); next([]); next([{ ...row, metadata: { [field]: 'pi_unrelated' } }]);
    expect(await resolveOriginalTransaction('pi_unrelated', log, row.appDid)).toBeUndefined();
    expect(h.session).toHaveBeenCalledWith('test-only-seller-key', row.externalRef);
    expect(renderWhere(h.where.mock.calls[2][0]).params).toEqual([row.appDid, 'stripe-byo', 'completed', 'partially_refunded', 'cs_']);
  });
  it('checks seller-owned session candidates filtered by authenticated app', async () => {
    next([]); next([]); next([row]);
    expect(await resolveOriginalTransaction('pi_test', log, row.appDid)).toEqual(row);
    expect(renderWhere(h.where.mock.calls[2][0]).params).toEqual([row.appDid, 'stripe-byo', 'completed', 'partially_refunded', 'cs_']);
    expect(h.keys).toHaveBeenCalledWith(row.toDid);
    expect(h.session).toHaveBeenCalledWith('test-only-seller-key', 'cs_test');
  });
  it('never queries a platform-account candidate', async () => {
    next([]); next([]); next([{ ...row, rail: 'stripe' }]);
    expect(await resolveOriginalTransaction('pi_test', log, row.appDid)).toBeUndefined();
    expect(h.keys).not.toHaveBeenCalled();
    expect(h.session).not.toHaveBeenCalled();
  });
  it('does not guess an intent for an unknown non-intent ID', async () => {
    next([]);
    expect(await resolveOriginalTransaction('missing', log, row.appDid)).toBeUndefined();
    expect(h.session).not.toHaveBeenCalled();
  });
  it('does not return a non-matching seller session', async () => {
    next([]); next([]); next([row]);
    h.session.mockResolvedValue('pi_other');
    expect(await resolveOriginalTransaction('pi_test', log, row.appDid)).toBeUndefined();
  });
  it('skips a missing seller key rather than looking on the platform account', async () => {
    next([]); next([]); next([row]);
    h.keys.mockRejectedValue(new SellerNoCardRailError());
    expect(await resolveOriginalTransaction('pi_test', log, row.appDid)).toBeUndefined();
    expect(h.session).not.toHaveBeenCalled();
  });
  it('logs only safe transaction context if a seller lookup fails', async () => {
    next([]); next([]); next([row]);
    h.session.mockRejectedValue(new Error('test-only-sensitive-upstream-detail'));
    expect(await resolveOriginalTransaction('pi_test', log, row.appDid)).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ transactionId: 'tx_1' }, expect.any(String));
  });
});

describe('refundSellerPayment', () => {
  it('uses the verified settlement PI without a Stripe session round-trip', async () => {
    await refundSellerPayment({ ...row, settledAt: new Date(), metadata: { settledPaymentIntentId: 'pi_verified' } } as never, 500);
    expect(h.session).not.toHaveBeenCalled();
    expect(h.refund).toHaveBeenCalledWith({ payment_intent: 'pi_verified', amount: 500 });
  });
  it.each([500, 1000])('refunds %i cents against the persisted seller PI', async (amount) => {
    await refundSellerPayment({ ...row, externalRef: 'pi_test' } as never, amount);
    expect(h.keys).toHaveBeenCalledWith(row.toDid);
    expect(h.client).toHaveBeenCalledWith('test-only-seller-key');
    expect(h.refund).toHaveBeenCalledWith({ payment_intent: 'pi_test', amount });
  });
  it('resolves a session to an intent on the same seller account', async () => {
    await refundSellerPayment(row as never, 500);
    expect(h.session).toHaveBeenCalledWith('test-only-seller-key', row.externalRef);
    expect(h.refund).toHaveBeenCalledWith({ payment_intent: 'pi_test', amount: 500 });
  });
  it.each(['paymentIntentId', 'stripePaymentIntentId', 'settledPaymentIntentId'])('ignores spoofed %s and refunds the seller-verified session intent', async (field) => {
    await refundSellerPayment({ ...row, metadata: { [field]: 'pi_unrelated' } } as never, 500);
    expect(h.session).toHaveBeenCalledWith('test-only-seller-key', row.externalRef);
    expect(h.refund).toHaveBeenCalledWith({ payment_intent: 'pi_test', amount: 500 });
  });
  it('never falls back to caller metadata when a session has no payment intent', async () => {
    h.session.mockResolvedValue(undefined);
    await expect(refundSellerPayment({ ...row, metadata: { paymentIntentId: 'pi_unrelated' } } as never, 500))
      .rejects.toThrow('Original seller payment intent');
    expect(h.refund).not.toHaveBeenCalled();
  });
  it('fails clearly for legacy platform payments without reading a key', async () => {
    await expect(refundSellerPayment({ ...row, rail: 'stripe' } as never, 500)).rejects.toThrow('LEGACY_PLATFORM_PAYMENT');
    expect(h.keys).not.toHaveBeenCalled();
    expect(h.refund).not.toHaveBeenCalled();
  });
  it('fails when no original payment intent can be established', async () => {
    h.session.mockResolvedValue(undefined);
    await expect(refundSellerPayment(row as never, 500)).rejects.toThrow('Original seller payment intent');
    expect(h.refund).not.toHaveBeenCalled();
  });
});
