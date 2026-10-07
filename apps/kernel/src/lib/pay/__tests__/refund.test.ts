/**
 * Unit tests for `resolveOriginalTransaction` (#2174) — specifically the
 * payment-intent (`pi_xxx`) fallback path, which previously built its own
 * ad-hoc Stripe client via a dynamic `import('stripe')` and now delegates
 * to the pay adapter's `findCheckoutSessionByPaymentIntent`. This path had
 * no direct unit coverage before (the route-level `refund-route.test.ts`
 * fixtures all resolve via the direct `externalRef` match, never the `pi_`
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

// REAL pay.transactions columns, so the `.where(...)` the lookups build can be rendered and asserted on.
vi.mock('@/src/db', async () => ({
  db: { select: mocks.selectMock },
  transactions: (await import('@/src/db/schemas/pay')).transactions,
}));

vi.mock('../providers/stripe-client', () => ({
  findCheckoutSessionByPaymentIntent: mocks.findCheckoutSessionMock,
}));

import { resolveOriginalTransaction } from '../refund';
import { renderWhere } from './mock-drizzle-table';

/** The rendered predicate of the n-th lookup: must filter on the Stripe rail's `external_ref`, never `stripe_id` (#2176). */
function lookupFor(n: number): { sql: string; params: unknown[] } {
  return renderWhere(mocks.whereMock.mock.calls[n][0]);
}

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
  it('returns the tx matched directly by externalRef (a checkout session id) without calling the adapter', async () => {
    nextSelect([{ id: 'tx_1', externalRef: 'cs_abc' }]);

    const result = await resolveOriginalTransaction('cs_abc', log);

    expect(result).toEqual({ id: 'tx_1', externalRef: 'cs_abc' });
    expect(mocks.findCheckoutSessionMock).not.toHaveBeenCalled();
    expect(lookupFor(0).sql).toContain('"external_ref"');
    expect(lookupFor(0).sql).not.toContain('stripe_id');
    expect(lookupFor(0).params).toEqual(['stripe', 'cs_abc']);
  });

  it('falls back to the adapter to resolve a payment intent id to its checkout session, then re-queries by session id', async () => {
    nextSelect([]); // no direct match on externalRef = 'pi_xxx'
    mocks.findCheckoutSessionMock.mockResolvedValue({ id: 'cs_resolved' });
    nextSelect([{ id: 'tx_2', externalRef: 'cs_resolved' }]);

    const result = await resolveOriginalTransaction('pi_xxx', log);

    expect(mocks.findCheckoutSessionMock).toHaveBeenCalledWith('pi_xxx');
    expect(result).toEqual({ id: 'tx_2', externalRef: 'cs_resolved' });
    expect(lookupFor(0).params).toEqual(['stripe', 'pi_xxx']);
    expect(lookupFor(1).sql).toContain('"external_ref"');
    expect(lookupFor(1).sql).not.toContain('stripe_id');
    expect(lookupFor(1).params).toEqual(['stripe', 'cs_resolved']);
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
