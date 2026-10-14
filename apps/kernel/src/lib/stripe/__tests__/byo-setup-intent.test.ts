import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SellerNoCardRailError } from '@/src/lib/pay/rails/stripe-keys';
import { setupIntentMetadata } from '@/src/lib/pay/setup-intent';
import { createByoSetupIntent, verifyByoSetupIntent } from '../byo-setup-intent';

const mocks = vi.hoisted(() => ({ resolveKeys: vi.fn(), fetch: vi.fn() }));
vi.mock('@/src/lib/pay/rails/stripe-keys', async (original) => ({
  ...await original<typeof import('@/src/lib/pay/rails/stripe-keys')>(),
  resolveDidStripeKeys: mocks.resolveKeys,
}));
vi.mock('@/src/lib/stripe/connector-core', () => {
  throw new Error('SetupIntent must not privately load connector credentials');
});

const appDid = 'did:imajin:app';
const binding = {
  pledgeId: 'pledge_1', eventId: 'event_1', buyerDid: 'did:imajin:buyer',
  sellerDid: 'did:imajin:seller', amount: 5000, currency: 'CAD',
};
const verification = { ...binding, setupIntentId: 'seti_123', customerId: 'cus_123' };
const customer = { id: 'cus_123', metadata: { buyerDid: binding.buyerDid } };
const intent = {
  id: 'seti_123', client_secret: 'seti_123_secret_test', status: 'succeeded',
  customer, payment_method: { id: 'pm_123', customer: 'cus_123' },
  metadata: setupIntentMetadata(appDid, binding),
};
const reply = (body: unknown) => new Response(JSON.stringify(body));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveKeys.mockResolvedValue({ secretKey: 'rk_test_account', publishableKey: 'pk_test_account' });
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('canonical SetupIntent key resolution', () => {
  it('returns the publishable key from the same single resolution used for creation', async () => {
    mocks.fetch.mockResolvedValueOnce(reply(customer)).mockResolvedValueOnce(reply(intent));
    expect(await createByoSetupIntent(appDid, binding)).toEqual({
      clientSecret: intent.client_secret, setupIntentId: intent.id, customerId: customer.id,
      publishableKey: 'pk_test_account',
    });
    expect(mocks.resolveKeys).toHaveBeenCalledTimes(1);
    expect(mocks.resolveKeys).toHaveBeenCalledWith(binding.sellerDid);
    for (const [, options] of mocks.fetch.mock.calls) {
      expect(options.headers.Authorization).toBe('Bearer rk_test_account');
    }
  });

  it('resolves again on each verification, so revocation blocks a previously verified intent', async () => {
    mocks.resolveKeys.mockResolvedValueOnce({ secretKey: 'rk_test_account', publishableKey: undefined })
      .mockRejectedValueOnce(new SellerNoCardRailError());
    mocks.fetch.mockResolvedValue(reply(intent));
    expect(await verifyByoSetupIntent(appDid, verification)).toEqual({
      verified: true, ...verification, paymentMethodId: 'pm_123',
    });
    await expect(verifyByoSetupIntent(appDid, verification)).rejects.toBeInstanceOf(SellerNoCardRailError);
    expect(mocks.resolveKeys).toHaveBeenCalledTimes(2);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][1].method).toBe('GET');
    expect(mocks.fetch.mock.calls[0][1].body).toBeUndefined();
  });

  it.each([createByoSetupIntent, verifyByoSetupIntent])('propagates missing/revoked keys without contacting Stripe', async (handler) => {
    mocks.resolveKeys.mockRejectedValue(new SellerNoCardRailError());
    await expect(handler(appDid, verification)).rejects.toBeInstanceOf(SellerNoCardRailError);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('fails creation closed without a publishable key %j', async (publishableKey) => {
    mocks.resolveKeys.mockResolvedValue({ secretKey: 'rk_test_account', publishableKey });
    await expect(createByoSetupIntent(appDid, binding)).rejects.toBeInstanceOf(SellerNoCardRailError);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
