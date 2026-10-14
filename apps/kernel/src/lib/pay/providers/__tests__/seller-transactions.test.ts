import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ values: vi.fn(), limit: vi.fn(), where: vi.fn(), set: vi.fn() }));
vi.mock('@/src/db', () => ({ db: {
  insert: () => ({ values: m.values }),
  select: () => ({ from: () => ({ where: (...args: unknown[]) => { m.where(...args); return { limit: m.limit }; } }) }),
  update: () => ({ set: (...args: unknown[]) => { m.set(...args); return { where: m.where }; } }),
} }));
import { findSellerEscrow, markSellerEscrow, persistSellerCharge, persistSellerEscrow } from '../seller-transactions';
const result = { id: 'pi_fake', provider: 'stripe' as const, status: 'succeeded' as const, amount: 123, currency: 'CAD' as const, createdAt: new Date(0), metadata: { seller_did: 'spoof', from_did: 'spoof', rail: 'stripe' } };
beforeEach(() => vi.resetAllMocks());
it('persists charge ownership and external rail, overwriting untrusted metadata', async () => {
  await persistSellerCharge(result, 'did:test:seller', 'did:test:buyer');
  expect(m.values).toHaveBeenCalledWith(expect.objectContaining({
    type: 'charge', toDid: 'did:test:seller', fromDid: 'did:test:buyer', amount: '1.23',
    status: 'completed', rail: 'stripe-byo', externalRef: 'pi_fake',
    metadata: expect.objectContaining({ seller_did: 'did:test:seller', from_did: 'did:test:buyer', rail: 'stripe-byo' }),
  }));
});
it('persists anonymous pending charge without inventing a payer', async () => {
  await persistSellerCharge({ ...result, status: 'requires_action' }, 'did:test:seller');
  expect(m.values).toHaveBeenCalledWith(expect.objectContaining({ fromDid: null, status: 'pending' }));
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
