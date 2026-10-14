import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const h = vi.hoisted(() => ({ construct: vi.fn(), search: vi.fn(), create: vi.fn(), session: vi.fn() }));
vi.mock('stripe', () => ({
  default: class {
    constructor(key: string, options: unknown) { h.construct(key, options); }
    customers = { search: h.search, create: h.create };
    checkout = { sessions: { retrieve: h.session } };
  },
}));
import { findOrCreatePledgeCustomer, sellerPledgeRefundClient, sellerSessionPaymentIntent } from '../seller-pledge-refund';
beforeEach(() => {
  vi.clearAllMocks();
  h.search.mockResolvedValue({ data: [] });
  h.create.mockResolvedValue({ id: 'cus_test' });
});
describe('explicit seller Stripe adapter', () => {
  it('keeps migrated card source free of singleton and environment fallbacks', () => {
    const root = resolve(__dirname, '../../../../../../../');
    for (const file of [
      'app/pay/api/setup-intent/route.ts', 'app/pay/api/refund/route.ts', 'app/pay/api/charge-pledges/route.ts',
      'src/lib/pay/app-pledges.ts', 'src/lib/pay/refund.ts', 'src/lib/pay/providers/seller-pledge-refund.ts',
    ]) {
      const source = readFileSync(resolve(root, 'apps/kernel', file), 'utf8');
      expect(source).not.toMatch(/getPaymentService|getStripeClient|STRIPE_SECRET_KEY|STRIPE_PUBLISHABLE_KEY/);
    }
  });
  it('never uses an environment fallback or caches across accounts', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'test-only-platform-key');
    expect(() => sellerPledgeRefundClient('')).toThrow('Seller card rail unavailable');
    sellerPledgeRefundClient('test-only-seller-a');
    sellerPledgeRefundClient('test-only-seller-b');
    expect(h.construct.mock.calls.map(([key]) => key)).toEqual(['test-only-seller-a', 'test-only-seller-b']);
    vi.unstubAllEnvs();
  });
  it('escapes Stripe search syntax rather than trusting buyer input', async () => {
    await findOrCreatePledgeCustomer('test-only-seller-key', "did:imajin:buyer'\\");
    expect(h.search).toHaveBeenCalledWith({ query: "metadata['did']:'did:imajin:buyer\\'\\\\'", limit: 1 });
  });
  it('searches buyer metadata on the seller account instead of using invalid list filtering', async () => {
    h.search.mockResolvedValue({ data: [{ id: 'cus_owned', metadata: { did: 'did:imajin:buyer' } }] });
    expect(await findOrCreatePledgeCustomer('test-only-seller-key', 'did:imajin:buyer')).toMatchObject({ id: 'cus_owned' });
    expect(h.search).toHaveBeenCalledWith({ query: "metadata['did']:'did:imajin:buyer'", limit: 1 });
    expect(h.construct).toHaveBeenCalledWith('test-only-seller-key', expect.any(Object));
    expect(h.create).not.toHaveBeenCalled();
  });
  it('never reuses a customer with another buyer binding', async () => {
    h.search.mockResolvedValue({ data: [{ id: 'cus_other', metadata: { did: 'did:imajin:other' } }] });
    await findOrCreatePledgeCustomer('test-only-seller-key', 'did:imajin:buyer');
    expect(h.create).toHaveBeenCalledWith({ metadata: { did: 'did:imajin:buyer', buyerDid: 'did:imajin:buyer' } });
  });
  it.each(['pi_test', { id: 'pi_test' }])('resolves unexpanded or expanded session intents', async (paymentIntent) => {
    h.session.mockResolvedValue({ payment_intent: paymentIntent });
    expect(await sellerSessionPaymentIntent('test-only-seller-key', 'cs_test')).toBe('pi_test');
    expect(h.session).toHaveBeenCalledWith('cs_test');
  });
  it('returns no intent for an unpaid session', async () => {
    h.session.mockResolvedValue({ payment_intent: null });
    expect(await sellerSessionPaymentIntent('test-only-seller-key', 'cs_test')).toBeUndefined();
  });
});
