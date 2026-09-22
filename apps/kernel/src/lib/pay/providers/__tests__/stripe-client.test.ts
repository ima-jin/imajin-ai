/**
 * Unit tests for `providers/stripe-client.ts` (#2174) — the single Stripe
 * SDK client factory that replaces the three separate instantiations that
 * used to live in `lib/pay/stripe.ts`, `providers/stripe.ts`, and
 * `refund.ts`.
 *
 * Mocks the `stripe` package directly (same approach as
 * `stripe-withdraw-rail.test.ts`) so these tests exercise the real factory
 * logic (lazy init, singleton caching, the missing-key error, and the
 * checkout-session lookup helper) against a fake SDK constructor.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const state = vi.hoisted(() => ({
  constructorCalls: [] as unknown[][],
  sessionsListMock: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: class FakeStripe {
    checkout = { sessions: { list: state.sessionsListMock } };
    constructor(...args: unknown[]) {
      state.constructorCalls.push(args);
    }
  },
}));

import {
  getStripeClient,
  isStripeConfigured,
  findCheckoutSessionByPaymentIntent,
  __resetStripeClientForTests,
} from '../stripe-client';

const ORIGINAL_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  state.constructorCalls.length = 0;
  __resetStripeClientForTests();
  delete process.env.STRIPE_SECRET_KEY;
});

// Restore the ambient env var (if any) once this file's tests finish, so
// later test files in the same worker never see a deleted key.
afterAll(() => {
  if (ORIGINAL_SECRET_KEY === undefined) {
    delete process.env.STRIPE_SECRET_KEY;
  } else {
    process.env.STRIPE_SECRET_KEY = ORIGINAL_SECRET_KEY;
  }
});

describe('getStripeClient', () => {
  it('throws a clear error when STRIPE_SECRET_KEY is not configured', () => {
    expect(() => getStripeClient()).toThrow('STRIPE_SECRET_KEY not configured');
    expect(state.constructorCalls).toHaveLength(0);
  });

  it('lazily constructs a Stripe client on first call using the configured key', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';

    const client = getStripeClient();

    expect(client).toBeDefined();
    expect(state.constructorCalls).toHaveLength(1);
    expect(state.constructorCalls[0][0]).toBe('sk_test_123');
  });

  it('returns the same cached instance on subsequent calls (singleton)', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';

    const first = getStripeClient();
    const second = getStripeClient();

    expect(first).toBe(second);
    expect(state.constructorCalls).toHaveLength(1);
  });

  it('does not reconstruct the client even if the env var changes after first init', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_first';
    const first = getStripeClient();

    process.env.STRIPE_SECRET_KEY = 'sk_test_second';
    const second = getStripeClient();

    expect(second).toBe(first);
    expect(state.constructorCalls).toHaveLength(1);
    expect(state.constructorCalls[0][0]).toBe('sk_test_first');
  });
});

describe('isStripeConfigured', () => {
  it('returns false when STRIPE_SECRET_KEY is unset', () => {
    expect(isStripeConfigured()).toBe(false);
  });

  it('returns true when STRIPE_SECRET_KEY is set, without constructing a client', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';

    expect(isStripeConfigured()).toBe(true);
    expect(state.constructorCalls).toHaveLength(0);
  });
});

describe('findCheckoutSessionByPaymentIntent', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
  });

  it('returns a domain-shaped session ref when a session matches the payment intent', async () => {
    state.sessionsListMock.mockResolvedValue({ data: [{ id: 'cs_test_abc' }] });

    const result = await findCheckoutSessionByPaymentIntent('pi_test_1');

    expect(result).toEqual({ id: 'cs_test_abc' });
    expect(state.sessionsListMock).toHaveBeenCalledWith({ payment_intent: 'pi_test_1', limit: 1 });
  });

  it('returns null when no session matches', async () => {
    state.sessionsListMock.mockResolvedValue({ data: [] });

    const result = await findCheckoutSessionByPaymentIntent('pi_missing');

    expect(result).toBeNull();
  });
});
