import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ construct: vi.fn() }));
vi.mock('stripe', () => ({
  default: class { constructor() { state.construct(); } },
}));

import { getStripeClient, isStripeConfigured, findCheckoutSessionByPaymentIntent } from '../stripe-client';
import { StripeProvider } from '../stripe';

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe('retired platform Stripe adapter', () => {
  it.each([undefined, 'sk_test_fake_ignored'])('fails closed with or without an obsolete env key (%s)', async key => {
    vi.stubEnv('STRIPE_SECRET_KEY', key);
    expect(() => getStripeClient()).toThrow('Legacy platform card payments are unavailable');
    expect(() => new StripeProvider({})).toThrow('Legacy platform card payments are unavailable');
    expect(isStripeConfigured()).toBe(false);
    await expect(findCheckoutSessionByPaymentIntent('pi_test_fake')).rejects.toThrow('Legacy platform card payments are unavailable');
    expect(state.construct).not.toHaveBeenCalled();
  });

  it('does not read any Stripe credential env value', () => {
    const env = process.env;
    const reads: string[] = [];
    process.env = new Proxy(env, {
      get(target, property) {
        if (typeof property === 'string' && property.startsWith('STRIPE_')) reads.push(property);
        return Reflect.get(target, property);
      },
    });
    try {
      expect(() => getStripeClient()).toThrow();
      expect(isStripeConfigured()).toBe(false);
      expect(reads).toEqual([]);
    } finally {
      process.env = env;
    }
  });
});
