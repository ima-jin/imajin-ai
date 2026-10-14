import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), capture: vi.fn(), cancel: vi.fn(), constructor: vi.fn() }));
vi.mock('stripe', () => ({ default: class {
  paymentIntents = mocks;
  constructor(key: string) { mocks.constructor(key); }
} }));
import { chargeSeller, createSellerStripeClient, escrowSeller, updateSellerEscrow } from '../seller-stripe-payments';

const intent = { id: 'pi_test_fake', amount: 123, currency: 'cad', created: 1, client_secret: 'fake-client-secret', metadata: {} };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockImplementation(async (params) => ({ ...intent, status: 'requires_action', metadata: params.metadata }));
  mocks.capture.mockResolvedValue(intent);
  mocks.cancel.mockResolvedValue(intent);
});
describe('explicit sealed-key adapter', () => {
  it('uses only supplied seller key and rejects an empty key even with platform env present', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_obvious_platform_fake');
    createSellerStripeClient('sk_test_obvious_seller_fake');
    expect(mocks.constructor).toHaveBeenCalledWith('sk_test_obvious_seller_fake');
    expect(() => createSellerStripeClient('')).toThrow('Seller card key is required');
    expect(mocks.constructor).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
  it('charges DID recipient, preserves customer and idempotency, and stamps metadata last', async () => {
    const result = await chargeSeller('sk_test_fake', 'did:test:seller', {
      amount: 123, currency: 'CAD', to: { did: 'did:test:seller', stripeCustomerId: 'cus_test_fake' },
      from: 'did:test:buyer', idempotencyKey: 'fake-dedupe',
      metadata: { seller_did: 'spoof', from_did: 'spoof', to_did: 'spoof', rail: 'stripe', note: 'keep' },
    });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      customer: 'cus_test_fake', currency: 'cad', amount: 123,
      metadata: { seller_did: 'did:test:seller', to_did: 'did:test:seller', from_did: 'did:test:buyer', rail: 'stripe-byo', note: 'keep' },
    }), { idempotencyKey: 'fake-dedupe' });
    expect(result.clientSecret).toBe('fake-client-secret');
  });
  it.each([
    ['succeeded', 'succeeded'], ['processing', 'pending'], ['requires_action', 'requires_action'],
    ['requires_confirmation', 'requires_action'], ['requires_payment_method', 'requires_action'],
    ['canceled', 'canceled'], ['requires_capture', 'failed'],
  ])('maps %s to %s', async (status, expected) => {
    mocks.create.mockResolvedValue({ ...intent, status, client_secret: null });
    const result = await chargeSeller('sk_test_fake', 'did:test:seller', { amount: 123, currency: 'CAD', to: { did: 'did:test:seller' } });
    expect(result.status).toBe(expected);
    expect(result.clientSecret).toBeUndefined();
  });
  it('creates manual capture escrow and prevents metadata party spoofing', async () => {
    const result = await escrowSeller('sk_test_fake', {
      amount: 123, currency: 'CAD', from: 'did:test:buyer', to: 'did:test:seller', arbiter: 'did:test:arbiter',
      metadata: { escrow: 'false', arbiter_did: 'spoof', to_did: 'spoof' },
    });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      capture_method: 'manual', metadata: expect.objectContaining({ escrow: 'true', arbiter_did: 'did:test:arbiter', to_did: 'did:test:seller' }),
    }));
    expect(result.clientSecret).toBe('fake-client-secret');
  });
  it.each(['release', 'refund'] as const)('%s uses explicit key and persisted external ref', async (action) => {
    const result = await updateSellerEscrow('sk_test_owner_fake', intent.id, action);
    expect(mocks.constructor).toHaveBeenCalledWith('sk_test_owner_fake');
    expect(action === 'refund' ? mocks.cancel : mocks.capture).toHaveBeenCalledWith(intent.id);
    expect(result.status).toBe(action === 'refund' ? 'refunded' : 'released');
  });
});
