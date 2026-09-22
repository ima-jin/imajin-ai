/**
 * Unit tests for `resolveOriginalTransaction` (#2174) — specifically the
 * payment-intent (`pi_xxx`) fallback path, which previously built its own
 * ad-hoc Stripe client via a dynamic `import('stripe')` and now delegates
 * to the pay adapter's `findCheckoutSessionByPaymentIntent`. This path had
 * no direct unit coverage before (the route-level `refund-route.test.ts`
 * fixtures all resolve via the direct `stripeId` match, never the `pi_`
 * fallback), so this file closes that gap for the migrated behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));
  const findCheckoutSessionMock = vi.fn();
  return { whereMock, fromMock, selectMock, findCheckoutSessionMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  transactions: { id: 'col_id', stripeId: 'col_stripeId' },
}));

vi.mock('../providers/stripe-client', () => ({
  findCheckoutSessionByPaymentIntent: mocks.findCheckoutSessionMock,
}));

import { resolveOriginalTransaction } from '../refund';

/** Make whereMock return `rows` on its next call, supporting both `.limit()` and direct await. */
function nextSelect(rows: unknown[]): void {
  const p = Promise.resolve(rows) as any;
  p.limit = vi.fn().mockResolvedValue(rows);
  mocks.whereMock.mockImplementationOnce(() => p);
}

const log = { error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveOriginalTransaction', () => {
  it('returns the tx matched directly by stripeId (a checkout session id) without calling the adapter', async () => {
    nextSelect([{ id: 'tx_1', stripeId: 'cs_abc' }]);

    const result = await resolveOriginalTransaction('cs_abc', log);

    expect(result).toEqual({ id: 'tx_1', stripeId: 'cs_abc' });
    expect(mocks.findCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('falls back to the adapter to resolve a payment intent id to its checkout session, then re-queries by session id', async () => {
    nextSelect([]); // no direct match on stripeId = 'pi_xxx'
    mocks.findCheckoutSessionMock.mockResolvedValue({ id: 'cs_resolved' });
    nextSelect([{ id: 'tx_2', stripeId: 'cs_resolved' }]);

    const result = await resolveOriginalTransaction('pi_xxx', log);

    expect(mocks.findCheckoutSessionMock).toHaveBeenCalledWith('pi_xxx');
    expect(result).toEqual({ id: 'tx_2', stripeId: 'cs_resolved' });
  });

  it('returns undefined without calling the adapter for a non-pi_ id with no direct match', async () => {
    nextSelect([]);

    const result = await resolveOriginalTransaction('unknown_id', log);

    expect(result).toBeUndefined();
    expect(mocks.findCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('returns undefined (no error log) when the adapter finds no session for the payment intent', async () => {
    nextSelect([]);
    mocks.findCheckoutSessionMock.mockResolvedValue(null);

    const result = await resolveOriginalTransaction('pi_missing', log);

    expect(result).toBeUndefined();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs and returns undefined (never throws) when the adapter call fails', async () => {
    nextSelect([]);
    mocks.findCheckoutSessionMock.mockRejectedValue(new Error('stripe down'));

    const result = await resolveOriginalTransaction('pi_err', log);

    expect(result).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('stripe down') }),
      expect.any(String),
    );
  });
});
