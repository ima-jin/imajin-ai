/**
 * Tests for POST /pay/api/webhook's signature verification and event-id
 * replay idempotency (#2175). Isolated from `golden-webhook-settlement.test.ts`
 * (which never sets a top-level Stripe event `id` on its fixtures, so it
 * never exercises the dedup path) — this suite specifically drives that id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface TxFixture {
  id: string;
  status: string;
}

const state = vi.hoisted(() => ({
  constructEventMock: vi.fn(),
  txRow: undefined as TxFixture | undefined,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
}));

function resetState() {
  state.txRow = undefined;
  state.updateCalls = [];
}

vi.mock('@/src/db', async () => {
  const { createMockDb, tableTag } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');

  const transactions = { __table: 'transactions' };
  const feeLedger = { __table: 'feeLedger' };

  function limitResultFor(table: unknown) {
    if (tableTag(table) === 'transactions') {
      return Promise.resolve(state.txRow ? [state.txRow] : []);
    }
    return Promise.resolve([]);
  }

  const { select, update, insert } = createMockDb(state, limitResultFor);
  return { db: { select, update, insert }, transactions, feeLedger };
});

vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));

vi.mock('@/src/lib/pay/providers/stripe-client', () => ({
  getStripeClient: () => ({ webhooks: { constructEvent: state.constructEventMock } }),
}));

vi.mock('@/src/lib/pay/payment-requests/checkout', () => ({
  settlePaymentRequestFromStripeCheckout: vi.fn(),
}));

import { POST } from '../route';

function makeRequest(hasSignature = true): Parameters<typeof POST>[0] {
  return new Request('http://localhost:3000/pay/api/webhook', {
    method: 'POST',
    headers: hasSignature ? { 'stripe-signature': 'sig_test' } : {},
    body: 'raw-body',
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
});

describe('POST /pay/api/webhook — signature verification (#2175)', () => {
  it('returns 400 when the signature is invalid', async () => {
    state.constructEventMock.mockImplementation(() => {
      throw new Error('bad signature');
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid signature');
  });

  it('returns 400 when the stripe-signature header is missing, without ever calling the Stripe SDK', async () => {
    const res = await POST(makeRequest(false));

    expect(res.status).toBe(400);
    expect(state.constructEventMock).not.toHaveBeenCalled();
  });

  it('returns 500 when STRIPE_WEBHOOK_SECRET is not configured', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
  });
});

describe('POST /pay/api/webhook — replayed event id produces no double RailEvent (#2175)', () => {
  it('a second delivery of the same Stripe event id is a no-op — no second transaction update', async () => {
    state.txRow = { id: 'tx_fixture', status: 'pending' };
    state.constructEventMock.mockReturnValue({
      id: 'evt_replay_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_replay', amount: 1000, currency: 'usd', metadata: {} } },
    });

    const first = await POST(makeRequest());
    expect(first.status).toBe(200);
    const updateCountAfterFirst = state.updateCalls.length;
    expect(updateCountAfterFirst).toBeGreaterThan(0);

    const replay = await POST(makeRequest());
    const replayBody = await replay.json();

    expect(replay.status).toBe(200);
    expect(replayBody.duplicate).toBe(true);
    // No new writes on replay — the event never reached the dispatch switch a second time.
    expect(state.updateCalls.length).toBe(updateCountAfterFirst);
  });

  it('two different event ids for the same underlying object are each processed (not conflated with each other)', async () => {
    state.txRow = { id: 'tx_fixture', status: 'pending' };
    state.constructEventMock.mockReturnValueOnce({
      id: 'evt_a',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_shared', amount: 1000, currency: 'usd', metadata: {} } },
    });
    const first = await POST(makeRequest());
    expect(first.status).toBe(200);
    const countAfterFirst = state.updateCalls.length;

    state.constructEventMock.mockReturnValueOnce({
      id: 'evt_b',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_shared', amount: 1000, currency: 'usd', metadata: {} } },
    });
    const second = await POST(makeRequest());
    const secondBody = await second.json();

    expect(second.status).toBe(200);
    expect(secondBody.duplicate).toBeUndefined();
    expect(state.updateCalls.length).toBeGreaterThan(countAfterFirst);
  });
});
