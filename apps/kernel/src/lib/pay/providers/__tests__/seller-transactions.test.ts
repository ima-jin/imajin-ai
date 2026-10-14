import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ values: vi.fn(), limit: vi.fn(), where: vi.fn(), set: vi.fn(), returning: vi.fn() }));
vi.mock('@/src/db', () => ({ db: {
  insert: () => ({ values: (...args: unknown[]) => {
    m.values(...args); return { onConflictDoNothing: () => ({ returning: m.returning }) };
  } }),
  select: () => ({ from: () => ({ where: (...args: unknown[]) => { m.where(...args); return { limit: m.limit }; } }) }),
  update: () => ({ set: (...args: unknown[]) => { m.set(...args); return { where: m.where }; } }),
} }));
import { findSellerEscrow, markSellerEscrow, prepareSellerCharge, persistSellerCharge, persistSellerEscrow } from '../seller-transactions';
const result = { id: 'pi_fake', provider: 'stripe' as const, status: 'succeeded' as const, amount: 123, currency: 'CAD' as const, createdAt: new Date(0), metadata: { seller_did: 'spoof', from_did: 'spoof', rail: 'stripe' } };
beforeEach(() => { vi.resetAllMocks(); m.returning.mockResolvedValue([{ id: 'tx_inserted' }]); });
it('persists charge ownership and external rail, overwriting untrusted metadata', async () => {
  const id = await prepareSellerCharge({
    amount: 123, currency: 'CAD', to: { did: 'did:test:seller' }, from: 'did:test:buyer',
    metadata: { ...result.metadata, appDid: 'did:test:spoof', payTransactionId: 'spoof', settledPaymentIntentId: 'pi_spoof' },
  }, 'did:test:seller');
  expect(m.values).toHaveBeenCalledWith(expect.objectContaining({
    id, type: 'charge', toDid: 'did:test:seller', fromDid: 'did:test:buyer', amount: '1.23',
    status: 'pending', rail: 'stripe-byo',
    metadata: expect.objectContaining({ payTransactionId: id, pay_transaction_id: id,
      seller_did: 'did:test:seller', from_did: 'did:test:buyer', rail: 'stripe-byo' }),
  }));
  expect(m.values.mock.calls[0][0].metadata).not.toHaveProperty('settledPaymentIntentId');
  expect(m.values.mock.calls[0][0]).not.toHaveProperty('settledAt');
  expect(m.values.mock.calls[0][0]).not.toHaveProperty('externalRef');
  expect(m.values.mock.calls[0][0]).not.toHaveProperty('appDid');
  expect(m.values.mock.calls[0][0].metadata).not.toHaveProperty('appDid');
});
it('persists only the independently verified app owner', async () => {
  await prepareSellerCharge({ amount: 123, currency: 'CAD', to: { did: 'did:test:seller' },
    metadata: { appDid: 'did:test:spoof' } }, 'did:test:seller', 'did:test:verified-app');
  expect(m.values).toHaveBeenCalledWith(expect.objectContaining({ appDid: 'did:test:verified-app',
    metadata: expect.objectContaining({ appDid: 'did:test:verified-app' }) }));
});
it('persists anonymous pending charge without inventing a payer', async () => {
  await prepareSellerCharge({ amount: 123, currency: 'CAD', to: { did: 'did:test:seller' } }, 'did:test:seller');
  expect(m.values).toHaveBeenCalledWith(expect.objectContaining({ fromDid: null, status: 'pending' }));
});
it('binds the SDK response without overwriting webhook status or verified metadata', async () => {
  await persistSellerCharge('tx_fake', result);
  expect(m.set).toHaveBeenCalledWith({ externalRef: result.id });
  expect(m.values).not.toHaveBeenCalled();
});
it('persists escrow parties after metadata so arbitrary callers cannot change authorization', async () => {
  await persistSellerEscrow({ ...result, status: 'held', from: 'did:test:buyer', to: 'did:test:seller' }, {
    amount: 123, currency: 'CAD', from: 'did:test:buyer', to: 'did:test:seller',
    metadata: { arbiter_did: 'spoof', to_did: 'spoof', escrow: 'false' },
  });
  expect(m.values).toHaveBeenCalledWith(expect.objectContaining({
    type: 'escrow', rail: 'stripe-byo', externalRef: 'pi_fake', status: 'held',
    metadata: expect.objectContaining({ arbiter_did: '', to_did: 'did:test:seller', escrow: 'true' }),
  }));
});
it('loads persisted escrow by external reference and updates only its transaction id', async () => {
  m.limit.mockResolvedValue([{ id: 'tx_fake' }]);
  expect(await findSellerEscrow('pi_fake')).toEqual({ id: 'tx_fake' });
  expect(m.where).toHaveBeenCalled();
  expect(m.limit).toHaveBeenCalledWith(1);
  await markSellerEscrow('tx_fake', 'refunded');
  expect(m.set).toHaveBeenCalledWith({ status: 'refunded' });
});
