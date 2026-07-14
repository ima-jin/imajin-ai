/**
 * Tests for apps/kernel/app/pay/api/refund/route.ts
 *
 * Covers the partial-refund guard introduced in #949:
 *  - First per-ticket refund → tx status becomes 'partially_refunded'
 *  - Second per-ticket refund on the same payment intent succeeds (the bug fix)
 *  - Fully-refunded guard still blocks subsequent refunds
 *  - Over-refund guard (cumulative > original amount) blocks with 400
 *  - Auth, validation, and not-found paths are also exercised
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  // Drizzle fluent-select chain:  db.select().from(x).where(y).limit(n)
  // whereMock returns a promise-like that also has .limit()
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  // Drizzle update chain: db.update(x).set(y).where(z)
  const updateWhereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  // Drizzle insert chain: db.insert(x).values(y).onConflictDoUpdate?(y)
  // values() must return an object (not a bare Promise) so that the optional
  // .onConflictDoUpdate() chain in the balance upsert doesn't throw.
  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
  const insertValuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateMock }));
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));

  // Pay service
  const refundMock = vi.fn();

  // Bus
  const publishMock = vi.fn().mockResolvedValue(undefined);

  return {
    whereMock,
    fromMock,
    selectMock,
    updateWhereMock,
    setMock,
    updateMock,
    onConflictDoUpdateMock,
    insertValuesMock,
    insertMock,
    refundMock,
    publishMock,
  };
});

// withLogger must be a transparent pass-through so that `POST` is callable directly.
vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: Function) =>
    (req: unknown) =>
      handler(req, {
        log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        correlationId: 'test-cor-id',
      }),
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

vi.mock('@/src/lib/pay/pay', () => ({
  getPaymentService: () => ({ refund: mocks.refundMock }),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: mocks.selectMock,
    update: mocks.updateMock,
    insert: mocks.insertMock,
  },
  transactions: {
    stripeId: 'col_stripeId',
    id: 'col_id',
    type: 'col_type',
    metadata: 'col_metadata',
    status: 'col_status',
  },
  balances: { did: 'col_did', cashAmount: 'col_cashAmount' },
}));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: () => 'tx_reversal_test' }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));
vi.mock('@imajin/bus', () => ({ publish: mocks.publishMock }));

// ─── Subject ────────────────────────────────────────────────────────────────

import { POST } from '../../../../app/pay/api/refund/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

const API_KEY = 'test-pay-api-key';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/api/refund', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

/** Make whereMock return `rows` on its next call, supporting both `.limit()` and direct await. */
function nextSelect(rows: unknown[]): void {
  const p = Promise.resolve(rows) as any;
  p.limit = vi.fn().mockResolvedValue(rows);
  mocks.whereMock.mockImplementationOnce(() => p);
}

const BASE_TX = {
  id: 'tx_original_1',
  service: 'events',
  type: 'ticket',
  fromDid: 'did:imajin:buyer',
  toDid: 'did:imajin:host',
  amount: '550.00',     // $550 = 2 × $275 tickets
  currency: 'CAD',
  status: 'completed',
  source: 'fiat',
  stripeId: 'cs_test_session_abc',
  metadata: {},
};

const REFUND_RESULT = {
  id: 're_test_stripe',
  paymentId: 'cs_test_session_abc',
  amount: 27500,
  status: 'succeeded',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/refund — partial refund guard (#949)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset whereMock to clear any leftover mockImplementationOnce entries
    // from a previous test that failed before consuming all its nextSelect calls.
    mocks.whereMock.mockReset();
    // Re-apply defaults cleared by mockReset:
    mocks.updateWhereMock.mockResolvedValue(undefined);
    mocks.onConflictDoUpdateMock.mockResolvedValue(undefined);
    process.env.PAY_SERVICE_API_KEY = API_KEY;
    mocks.refundMock.mockResolvedValue(REFUND_RESULT);
    mocks.publishMock.mockResolvedValue(undefined);
  });

  it('returns 401 when API key is missing', async () => {
    const req = new Request('https://kernel.test/api/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentId: 'cs_xxx' }),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(401);
  });

  it('returns 400 when paymentId is missing', async () => {
    const res = await POST(makeRequest({}) as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('paymentId is required');
  });

  it('returns 404 when no transaction matches the paymentId', async () => {
    nextSelect([]);   // no tx found by stripeId
    const res = await POST(makeRequest({ paymentId: 'cs_unknown' }) as any);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it('returns 400 (fully refunded) when tx.status is already "refunded"', async () => {
    nextSelect([{ ...BASE_TX, status: 'refunded' }]);  // originalTx: already done

    const res = await POST(makeRequest({ paymentId: 'cs_test_session_abc', amount: 27500 }) as any);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Transaction already fully refunded');
    expect(mocks.refundMock).not.toHaveBeenCalled();
  });

  it('marks tx as partially_refunded after the first per-ticket refund', async () => {
    // originalTx: $550 total, no prior refunds, no settlement entries
    nextSelect([BASE_TX]);   // (1) find original tx
    nextSelect([]);          // (2) existing refund txs — none yet
    nextSelect([]);          // (3) settlement txs — none (stripeId = cs_ so checkoutStripeId is set, but returns empty)

    const res = await POST(makeRequest({ paymentId: 'cs_test_session_abc', amount: 27500 }) as any);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactionId).toBe('tx_reversal_test');

    // Original tx should be marked partially_refunded (not fully refunded)
    expect(mocks.setMock).toHaveBeenCalledWith({ status: 'partially_refunded' });
    expect(mocks.refundMock).toHaveBeenCalledWith({
      paymentId: 'cs_test_session_abc',
      amount: 27500,
      reason: undefined,
    });
  });

  it('marks tx as refunded after the final per-ticket refund (the #949 bug fix)', async () => {
    // Simulate the Joel Dubin scenario: 2 tickets × $275 on one payment intent.
    // First ticket already refunded ($275), now refunding the second ($275).
    const partiallyRefundedTx = { ...BASE_TX, status: 'partially_refunded' };
    const firstTicketRefundTx = { id: 'tx_refund_ticket1', amount: '275.00', type: 'refund', currency: 'CAD', source: 'fiat' };

    nextSelect([partiallyRefundedTx]);     // (1) find original tx — status is partially_refunded, not 'refunded'
    nextSelect([firstTicketRefundTx]);     // (2) existing refund txs — $275 already refunded
    nextSelect([]);                        // (3) settlement txs — none

    const res = await POST(makeRequest({ paymentId: 'cs_test_session_abc', amount: 27500 }) as any);

    // Previously this would return 400 "Transaction already refunded".
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactionId).toBe('tx_reversal_test');

    // Both tickets now refunded: status should become 'refunded'
    expect(mocks.setMock).toHaveBeenCalledWith({ status: 'refunded' });
  });

  it('returns 400 when cumulative refund would exceed the original amount', async () => {
    // $350 already refunded on a $550 tx; requesting another $275 = $625 > $550
    const partiallyRefundedTx = { ...BASE_TX, status: 'partially_refunded' };
    const existingRefund = { id: 'tx_refund_1', amount: '350.00', type: 'refund' };

    nextSelect([partiallyRefundedTx]);   // (1) find original tx
    nextSelect([existingRefund]);        // (2) existing refunds totalling $350

    const res = await POST(makeRequest({ paymentId: 'cs_test_session_abc', amount: 27500 }) as any);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Refund would exceed original transaction amount');
    expect(mocks.refundMock).not.toHaveBeenCalled();
  });

  it('reverses settlement entries proportionally for a partial refund', async () => {
    // One settlement entry worth $50 (platform fee). First ticket = 50% refund.
    // Expect reversal of $25 (50% of $50).
    const settlementTx = {
      id: 'tx_settlement_1',
      service: 'events',
      type: 'settlement',
      fromDid: 'did:imajin:host',
      toDid: 'did:imajin:platform',
      amount: '50.00',
      currency: 'CAD',
      status: 'completed',
      source: 'fiat',
      batchId: null,
      metadata: { stripeSessionId: 'cs_test_session_abc' },
    };

    nextSelect([BASE_TX]);         // (1) original tx: $550
    nextSelect([]);                // (2) no prior refunds
    nextSelect([settlementTx]);   // (3) one settlement entry

    const res = await POST(makeRequest({ paymentId: 'cs_test_session_abc', amount: 27500 }) as any);
    expect(res.status).toBe(200);

    // Settlement reversal amount should be $50 × (275/550) = $25
    const insertCall = mocks.insertValuesMock.mock.calls.find((c: any[]) =>
      c[0]?.metadata?.refundOfSettlement === true
    );
    expect(insertCall).toBeDefined();
    const reversalAmount = Number.parseFloat(insertCall![0].amount);
    expect(reversalAmount).toBeCloseTo(25, 5);

    // Settlement entry status → partially_refunded (not yet fully reversed)
    const statusUpdates = mocks.setMock.mock.calls.map((c: any[]) => c[0].status);
    expect(statusUpdates).toContain('partially_refunded');
  });

  it('marks settlement entries as refunded on the final full refund', async () => {
    const settlementTx = {
      id: 'tx_settlement_2',
      service: 'events',
      type: 'settlement',
      fromDid: 'did:imajin:host',
      toDid: 'did:imajin:platform',
      amount: '50.00',
      currency: 'CAD',
      status: 'partially_refunded',
      source: 'fiat',
      batchId: null,
      metadata: { stripeSessionId: 'cs_test_session_abc' },
    };

    // Second and final ticket: $275 out of $550
    nextSelect([{ ...BASE_TX, status: 'partially_refunded' }]);
    nextSelect([{ id: 'tx_r1', amount: '275.00', type: 'refund' }]);
    nextSelect([settlementTx]);

    const res = await POST(makeRequest({ paymentId: 'cs_test_session_abc', amount: 27500 }) as any);
    expect(res.status).toBe(200);

    // Settlement entry should now be fully refunded
    const statusUpdates = mocks.setMock.mock.calls.map((c: any[]) => c[0].status);
    expect(statusUpdates).toContain('refunded');
  });
});
