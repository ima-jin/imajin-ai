/**
 * #2757: settlement of a hosted checkout paid on the SELLER'S OWN Stripe account.
 * Everything that must hold for the owner's event to complete the row — and the
 * guarantee that nothing is written when it does not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  selectRows: [] as Array<Record<string, unknown>>,
  updateReturning: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<Record<string, unknown>>,
  retrieveCustomerMock: vi.fn(),
  warnMock: vi.fn(),
}));

// Flat chain helpers (not nested lambdas): select().from().where().limit() and update().set().where().returning().
async function selectLimit() {
  return h.selectRows;
}
async function updateReturning() {
  return h.updateReturning;
}
function selectWhere() {
  return { limit: selectLimit };
}
function selectFrom() {
  return { where: selectWhere };
}
function updateWhere() {
  return { returning: updateReturning };
}
function updateSet(values: Record<string, unknown>) {
  h.updateCalls.push(values);
  return { where: updateWhere };
}

vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: selectFrom }), update: () => ({ set: updateSet }) },
  transactions: { id: 'id', rail: 'rail', status: 'status' },
}));
vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ and: conditions }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
}));
vi.mock('@/src/lib/stripe/byo-checkout', () => ({ retrieveByoCheckoutCustomer: h.retrieveCustomerMock }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: h.warnMock, error: vi.fn() }) }));

import { settleCheckoutFromByoStripe } from '../byo-checkout-settlement';

const OWNER = 'did:imajin:organizer';
const INPUT = { ownerDid: OWNER, transactionId: 'tx_1', paymentIntentId: 'pi_1', amount: 2500, currency: 'CAD' };

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx_1',
    rail: 'stripe-byo',
    status: 'pending',
    toDid: OWNER,
    amount: '25',
    currency: 'CAD',
    externalRef: 'cs_1',
    metadata: { service: 'events', eventId: 'ev_1', customer_email: 'given@example.com', platform_fee_cents: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  h.selectRows.length = 0;
  h.updateReturning.length = 0;
  h.updateCalls.length = 0;
  h.retrieveCustomerMock.mockReset().mockResolvedValue({ email: 'paid@example.com', name: 'Pat Buyer' });
  h.warnMock.mockReset();
});

describe('settleCheckoutFromByoStripe', () => {
  it('completes the pending row and returns a Checkout-Session-shaped record for the originating service', async () => {
    h.selectRows.push(pendingRow());
    h.updateReturning.push({ id: 'tx_1' });

    const outcome = await settleCheckoutFromByoStripe(INPUT);

    expect(outcome).toEqual({
      settled: true,
      session: {
        id: 'cs_1',
        amount_total: 2500,
        currency: 'cad',
        customer_email: 'paid@example.com',
        customer_details: { email: 'paid@example.com', name: 'Pat Buyer' },
        // Only string metadata is carried; the numeric platform_fee_cents bookkeeping stays on the row.
        metadata: { service: 'events', eventId: 'ev_1', customer_email: 'given@example.com' },
        payment_intent: 'pi_1',
        // So events' webhook (#2739) can settle by the kernel transaction id without a platform-rail lookup.
        transactionId: 'tx_1',
        // #2773: market (and any app) is told the kernel settled this on the seller's own account.
        rail: 'stripe-byo',
      },
    });
    // The buyer is read back with the SELLER's key, from the seller's own session.
    expect(h.retrieveCustomerMock).toHaveBeenCalledWith(OWNER, 'cs_1');
    // Only the status flips — no fee, chain or tax rows exist on this path.
    expect(h.updateCalls).toEqual([{ status: 'completed' }]);
  });

  it('falls back to the email given at checkout when the seller\'s session cannot be read back', async () => {
    h.selectRows.push(pendingRow());
    h.updateReturning.push({ id: 'tx_1' });
    h.retrieveCustomerMock.mockRejectedValue(new Error('stripe down'));

    const outcome = await settleCheckoutFromByoStripe(INPUT);

    expect(outcome).toMatchObject({
      settled: true,
      session: { customer_email: 'given@example.com', customer_details: { email: 'given@example.com', name: null } },
    });
    expect(h.warnMock).toHaveBeenCalled();
  });

  it('prefers the email the seller\'s Stripe collected over the one given up front', async () => {
    h.selectRows.push(pendingRow());
    h.updateReturning.push({ id: 'tx_1' });
    h.retrieveCustomerMock.mockResolvedValue({ email: null, name: null });

    const outcome = await settleCheckoutFromByoStripe(INPUT);

    expect(outcome).toMatchObject({ settled: true, session: { customer_email: 'given@example.com' } });
  });

  it.each([
    ['the row does not exist (or is not on the BYO rail)', undefined, 'not_found'],
    ['the event\'s owner is not the checkout\'s seller', pendingRow({ toDid: 'did:imajin:someone-else' }), 'not_seller'],
    ['the charge is a different amount than the row', pendingRow({ amount: '30' }), 'amount_mismatch'],
    ['the charge is in a different currency', pendingRow({ currency: 'USD' }), 'amount_mismatch'],
    ['the row is already completed (a replay)', pendingRow({ status: 'completed' }), 'not_pending'],
  ])('writes nothing when %s', async (_label, row, reason) => {
    if (row) h.selectRows.push(row);

    expect(await settleCheckoutFromByoStripe(INPUT)).toEqual({ settled: false, reason });
    expect(h.updateCalls).toHaveLength(0);
    expect(h.retrieveCustomerMock).not.toHaveBeenCalled();
  });

  it('does not log a plain replay as a refusal', async () => {
    h.selectRows.push(pendingRow({ status: 'completed' }));

    await settleCheckoutFromByoStripe(INPUT);

    expect(h.warnMock).not.toHaveBeenCalled();
  });

  it('logs a refusal that is not a replay', async () => {
    h.selectRows.push(pendingRow({ toDid: 'did:imajin:someone-else' }));

    await settleCheckoutFromByoStripe(INPUT);

    expect(h.warnMock).toHaveBeenCalledWith(expect.objectContaining({ reason: 'not_seller' }), expect.any(String));
  });

  it('loses a race cleanly: the guarded update matching no row settles nothing and notifies nobody', async () => {
    h.selectRows.push(pendingRow());
    // The guarded UPDATE found the row no longer pending.

    expect(await settleCheckoutFromByoStripe(INPUT)).toEqual({ settled: false, reason: 'lost_race' });
    expect(h.retrieveCustomerMock).not.toHaveBeenCalled();
  });

  it('rounds the stored dollar amount to the cent before comparing with Stripe\'s minor units', async () => {
    h.selectRows.push(pendingRow({ amount: '19.99' }));
    h.updateReturning.push({ id: 'tx_1' });

    expect(await settleCheckoutFromByoStripe({ ...INPUT, amount: 1999 })).toMatchObject({ settled: true });
  });
});
