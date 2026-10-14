import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rail: vi.fn(), credentials: vi.fn(), unseal: vi.fn() }));
vi.mock('../../payment-requests/card-rail', () => ({
  resolveCardRail: mocks.rail, SELLER_NO_CARD_RAIL: 'SELLER_NO_CARD_RAIL',
}));
vi.mock('@/src/lib/stripe/connector-core', () => ({
  stripe: { loadSealedCredentials: mocks.credentials },
  stripePublishableKeyField: (did: string) => `stripe-publishable-key:${did}`,
}));
vi.mock('@/src/lib/vault', () => ({ loadAndUnseal: mocks.unseal }));
import { resolveDidStripeKeys, SellerNoCardRailError } from '../stripe-keys';

const DID = 'did:imajin:seller';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rail.mockResolvedValue({ kind: 'connector', ownerDid: DID });
  mocks.credentials.mockResolvedValue({ apiKey: 'rk_test_fake' });
  mocks.unseal.mockResolvedValue('pk_test_fake');
});
describe('resolveDidStripeKeys', () => {
  it('never reads node Stripe env credentials, including on a missing sealed key', async () => {
    const env = new Proxy(process.env, {
      get(target, property) {
        if (property === 'STRIPE_SECRET_KEY' || property === 'STRIPE_PUBLISHABLE_KEY') {
          throw new Error('Node Stripe credential read');
        }
        return Reflect.get(target, property);
      },
    });
    vi.stubGlobal('process', { ...process, env });
    try {
      expect(await resolveDidStripeKeys(DID)).toEqual({ secretKey: 'rk_test_fake', publishableKey: 'pk_test_fake' });
      mocks.credentials.mockResolvedValue(undefined);
      await expect(resolveDidStripeKeys(DID)).rejects.toMatchObject({ code: 'SELLER_NO_CARD_RAIL' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('reads both credentials from the same DID connector', async () => {
    expect(await resolveDidStripeKeys(DID)).toEqual({ secretKey: 'rk_test_fake', publishableKey: 'pk_test_fake' });
    expect(mocks.rail).toHaveBeenCalledWith(DID);
    expect(mocks.credentials).toHaveBeenCalledWith(DID);
    expect(mocks.unseal).toHaveBeenCalledWith(`stripe-publishable-key:${DID}`);
  });
  it.each(['', 'platform'])('rejects an absent/invalid DID %s before resolving keys', async (did) => {
    await expect(resolveDidStripeKeys(did)).rejects.toBeInstanceOf(SellerNoCardRailError);
    expect(mocks.credentials).not.toHaveBeenCalled();
  });
  it('fails closed when the rail is missing', async () => {
    mocks.rail.mockResolvedValue({ kind: 'none' });
    await expect(resolveDidStripeKeys(DID)).rejects.toMatchObject({ code: 'SELLER_NO_CARD_RAIL' });
    expect(mocks.credentials).not.toHaveBeenCalled();
  });
  it.each([undefined, {}, { apiKey: '' }])('fails closed when the sealed key disappears', async (credentials) => {
    mocks.credentials.mockResolvedValue(credentials);
    await expect(resolveDidStripeKeys(DID)).rejects.toMatchObject({ code: 'SELLER_NO_CARD_RAIL' });
    expect(mocks.unseal).not.toHaveBeenCalled();
  });
  it('does not invent a publishable key for older connectors', async () => {
    mocks.unseal.mockResolvedValue(undefined);
    expect(await resolveDidStripeKeys(DID)).toEqual({ secretKey: 'rk_test_fake', publishableKey: undefined });
  });
  it('propagates unreadable vault errors without trying another account', async () => {
    mocks.credentials.mockRejectedValueOnce(new Error('vault unavailable'));
    await expect(resolveDidStripeKeys(DID)).rejects.toThrow('vault unavailable');
  });
});
