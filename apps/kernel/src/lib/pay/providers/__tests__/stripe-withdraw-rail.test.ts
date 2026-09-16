/**
 * Contract test for `StripeWithdrawRail` (#2172) against a mocked `stripe`
 * SDK — the only test in this suite family allowed to mock the `stripe`
 * package, since this is the one file that's allowed to import it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  transferCreateMock: vi.fn(),
  transferListMock: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: class {
    transfers = { create: state.transferCreateMock, list: state.transferListMock };
  },
}));

import { StripeWithdrawRail } from '../stripe-withdraw-rail';
import type { WithdrawalIntent } from '../../rails/types';

const intent: WithdrawalIntent = {
  id: 'wdi_1',
  did: 'did:imajin:owner',
  unit: 'MJN',
  amount: '5',
  rail: 'stripe',
  idempotencyKey: 'wdi_1',
  destination: 'acct_1',
  currency: 'CAD',
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test';
});

describe('StripeWithdrawRail.execute', () => {
  it('passes idempotencyKey and metadata.intent_id to transfers.create', async () => {
    state.transferCreateMock.mockResolvedValue({ id: 'tr_123' });
    const rail = new StripeWithdrawRail();

    const result = await rail.execute(intent);

    expect(result).toEqual({ externalRef: 'tr_123' });
    expect(state.transferCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 500,
        currency: 'cad',
        destination: 'acct_1',
        metadata: expect.objectContaining({ intent_id: 'wdi_1' }),
      }),
      { idempotencyKey: 'wdi_1' },
    );
  });

  it('throws when the intent has no destination', async () => {
    const rail = new StripeWithdrawRail();
    await expect(rail.execute({ ...intent, destination: undefined })).rejects.toThrow(/destination/);
    expect(state.transferCreateMock).not.toHaveBeenCalled();
  });

  it('converts an exact decimal amount to minor units without float rounding drift (#2172 review fix 3)', async () => {
    // `Number.parseFloat('12.345') * 100 === 1234.5` and plain `Math.round`
    // rounds a tie away from zero, giving 1235 — but the rest of
    // `packages/money` (and `fromDecimalString`, which this adapter now
    // uses) banker's-rounds ties to the nearest EVEN cent, giving 1234.
    // `parseFloat`/`Math.round` on a value that moves real money is wrong
    // twice over: it can drift from the true decimal value at all (not
    // demonstrated by this particular amount, but a real risk for others),
    // and even when it doesn't drift, it silently uses a different
    // rounding convention than every other money computation in this
    // codebase.
    expect(Math.round(Number.parseFloat('12.345') * 100)).toBe(1235); // the convention this fix removes

    state.transferCreateMock.mockResolvedValue({ id: 'tr_exact' });
    const rail = new StripeWithdrawRail();

    await rail.execute({ ...intent, amount: '12.345' });

    expect(state.transferCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1234 }),
      expect.anything(),
    );
  });
});

describe('StripeWithdrawRail.list', () => {
  it('maps Stripe transfers to RailTransfer[]', async () => {
    state.transferListMock.mockResolvedValue({
      data: [
        { id: 'tr_1', amount: 500, created: 1700000000, metadata: { intent_id: 'wdi_1' } },
        { id: 'tr_2', amount: 250, created: 1700000100, metadata: {} },
      ],
    });
    const rail = new StripeWithdrawRail();

    const transfers = await rail.list({ since: new Date(1700000000 * 1000) });

    expect(transfers).toEqual([
      { externalRef: 'tr_1', intentId: 'wdi_1', amount: 5, unit: 'MJN', createdAt: new Date(1700000000 * 1000) },
      { externalRef: 'tr_2', intentId: null, amount: 2.5, unit: 'MJN', createdAt: new Date(1700000100 * 1000) },
    ]);
    expect(state.transferListMock).toHaveBeenCalledWith(
      expect.objectContaining({ created: { gte: 1700000000 } }),
    );
  });
});

describe('StripeWithdrawRail.confirmFromEvent', () => {
  it("extracts the intent id + external ref from a 'transfer.created' event", async () => {
    const rail = new StripeWithdrawRail();
    const result = await rail.confirmFromEvent({
      type: 'transfer.created',
      data: { object: { id: 'tr_1', metadata: { intent_id: 'wdi_1' } } },
    });
    expect(result).toEqual({ intentId: 'wdi_1', externalRef: 'tr_1' });
  });

  it('returns null for an unrelated event type', async () => {
    const rail = new StripeWithdrawRail();
    const result = await rail.confirmFromEvent({ type: 'payment_intent.succeeded', data: { object: {} } });
    expect(result).toBeNull();
  });

  it('returns null when the transfer has no intent_id metadata', async () => {
    const rail = new StripeWithdrawRail();
    const result = await rail.confirmFromEvent({
      type: 'transfer.created',
      data: { object: { id: 'tr_1', metadata: {} } },
    });
    expect(result).toBeNull();
  });

  it('returns null for a non-object payload without throwing', async () => {
    const rail = new StripeWithdrawRail();
    expect(await rail.confirmFromEvent(null)).toBeNull();
    expect(await rail.confirmFromEvent('nope')).toBeNull();
  });
});
