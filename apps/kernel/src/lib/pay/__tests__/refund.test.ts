import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  where: vi.fn(), keys: vi.fn(), session: vi.fn(), refund: vi.fn(), client: vi.fn(),
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
  externalRef: 'cs_test', metadata: {} };
function next(rows: unknown[]) {
  const result = Object.assign(Promise.resolve(rows), { limit: vi.fn().mockResolvedValue(rows) });
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
  it('matches both rail namespaces directly without reading any keys', async () => {
    next([row]);
    expect(await resolveOriginalTransaction('cs_test', log, row.appDid)).toEqual(row);
    const predicate = renderWhere(h.where.mock.calls[0][0]);
    expect(predicate.params).toEqual(['stripe', 'cs_test', 'stripe-byo', 'cs_test']);
    expect(h.keys).not.toHaveBeenCalled();
  });
  it('uses persisted PI metadata before any account API lookup', async () => {
    next([]); next([{ ...row, metadata: { paymentIntentId: 'pi_test' } }]);
    expect(await resolveOriginalTransaction('pi_test', log, row.appDid)).toMatchObject({ id: 'tx_1' });
    expect(h.session).not.toHaveBeenCalled();
    expect(renderWhere(h.where.mock.calls[1][0]).params).toEqual([row.appDid]);
  });
  it('checks seller-owned session candidates filtered by authenticated app', async () => {
    next([]); next([row]);
    expect(await resolveOriginalTransaction('pi_test', log, row.appDid)).toEqual(row);
    expect(renderWhere(h.where.mock.calls[1][0]).params).toEqual([row.appDid]);
    expect(h.keys).toHaveBeenCalledWith(row.toDid);
    expect(h.session).toHaveBeenCalledWith('test-only-seller-key', 'cs_test');
  });
  it('never queries a platform-account candidate', async () => {
    next([]); next([{ ...row, rail: 'stripe' }]);
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
    next([]); next([row]);
    h.session.mockResolvedValue('pi_other');
    expect(await resolveOriginalTransaction('pi_test', log, row.appDid)).toBeUndefined();
  });
  it('propagates missing seller key rather than looking on the platform account', async () => {
    next([]); next([row]);
    h.keys.mockRejectedValue(new SellerNoCardRailError());
    await expect(resolveOriginalTransaction('pi_test', log, row.appDid)).rejects.toBeInstanceOf(SellerNoCardRailError);
    expect(h.session).not.toHaveBeenCalled();
  });
  it('logs only safe transaction context if a seller lookup fails', async () => {
    next([]); next([row]);
    h.session.mockRejectedValue(new Error('test-only-sensitive-upstream-detail'));
    expect(await resolveOriginalTransaction('pi_test', log, row.appDid)).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ transactionId: 'tx_1' }, expect.any(String));
  });
});

describe('refundSellerPayment', () => {
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
  it('uses persisted intent metadata without reading the session', async () => {
    await refundSellerPayment({ ...row, metadata: { paymentIntentId: 'pi_recorded' } } as never, 500);
    expect(h.session).not.toHaveBeenCalled();
    expect(h.refund).toHaveBeenCalledWith({ payment_intent: 'pi_recorded', amount: 500 });
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
