/**
 * Tests for the `transfer.created` fast path wired into the pay webhook
 * route (#2172). Isolated from `golden-webhook-settlement.test.ts` — this
 * suite only exercises the new case, mocking `confirmWithdrawalFromRailEvent`
 * / `getWithdrawRailByName` directly rather than driving through a full DB
 * fake (that idempotency/confirm behavior is covered by
 * `src/lib/pay/__tests__/withdraw-intent.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  constructEventMock: vi.fn(),
  confirmWithdrawalFromRailEventMock: vi.fn(),
}));

vi.mock('@/src/db', () => ({ db: {}, transactions: {}, feeLedger: {} }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));

vi.mock('@/src/lib/pay/providers/stripe-client', () => ({
  getStripeClient: () => ({ webhooks: { constructEvent: state.constructEventMock } }),
}));

// #2209: the route now also imports `payment-requests/checkout.ts`, which
// transitively pulls in `node-identity.ts` — mocked here so its
// module-scope `getClient()` call never runs against a real (absent in
// tests) DATABASE_URL.
vi.mock('@/src/lib/pay/payment-requests/checkout', () => ({
  settlePaymentRequestFromStripeCheckout: vi.fn(),
}));

vi.mock('@/src/lib/pay/withdraw-intent', () => ({
  confirmWithdrawalFromRailEvent: state.confirmWithdrawalFromRailEventMock,
}));

vi.mock('@/src/lib/pay/rails/registry', () => ({
  getWithdrawRailByName: (name: string) => (name === 'stripe' ? { name: 'stripe' } : null),
}));

import { POST } from '../route';

function makeRequest(): Parameters<typeof POST>[0] {
  return new Request('http://localhost:3000/pay/api/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: 'raw-body',
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
});

describe("POST /pay/api/webhook — 'transfer.created' fast path (#2172)", () => {
  it("resolves the stripe rail and confirms the withdrawal intent for a 'transfer.created' event", async () => {
    state.constructEventMock.mockReturnValue({
      type: 'transfer.created',
      data: { object: { id: 'tr_1', metadata: { intent_id: 'wdi_1' } } },
    });
    state.confirmWithdrawalFromRailEventMock.mockResolvedValue('wdi_1');

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(state.confirmWithdrawalFromRailEventMock).toHaveBeenCalledWith(
      { name: 'stripe' },
      expect.objectContaining({ type: 'transfer.created' }),
    );
  });

  it('still returns 200 (idempotent no-op) when confirmWithdrawalFromRailEvent finds nothing to confirm', async () => {
    state.constructEventMock.mockReturnValue({
      type: 'transfer.created',
      data: { object: { id: 'tr_2', metadata: {} } },
    });
    state.confirmWithdrawalFromRailEventMock.mockResolvedValue(null);

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
  });
});
