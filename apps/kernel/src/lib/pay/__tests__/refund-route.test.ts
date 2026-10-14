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
  const keysMock = vi.fn();
  const sessionMock = vi.fn();
  const logErrorMock = vi.fn();

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
    keysMock,
    sessionMock,
    logErrorMock,
    publishMock,
  };
});

// withLogger must be a transparent pass-through so that `POST` is callable directly.
vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: Function) =>
    (req: unknown) =>
      handler(req, {
        log: { error: mocks.logErrorMock, info: vi.fn(), warn: vi.fn() },
        correlationId: 'test-cor-id',
      }),
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

vi.mock('@/src/lib/pay/rails/stripe-keys', () => ({
  resolveDidStripeKeys: mocks.keysMock,
  SellerNoCardRailError: class extends Error { code = 'SELLER_NO_CARD_RAIL'; },
}));
vi.mock('@/src/lib/pay/providers/seller-pledge-refund', () => ({
  sellerPledgeRefundClient: () => ({ refunds: { create: mocks.refundMock } }),
  sellerSessionPaymentIntent: mocks.sessionMock,
}));

vi.mock('@/src/db', () => ({
  db: {
    select: mocks.selectMock,
    update: mocks.updateMock,
    insert: mocks.insertMock,
  },
  transactions: {
    externalRef: 'col_externalRef',
    rail: 'col_rail',
    id: 'col_id',
    type: 'col_type',
    metadata: 'col_metadata',
    status: 'col_status',
  },
  balances: { did: 'col_did', unit: 'col_unit', amount: 'col_amount' },
}));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: () => 'tx_reversal_test' }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@imajin/bus', () => ({ publish: mocks.publishMock }));
vi.mock('@/src/lib/pay/app-settle', () => ({
  authenticatePayApp: async (request: Request) => request.headers.get('authorization')
    ? { appDid: 'did:imajin:events' }
    : { error: 'App-service token required', status: 401 },
}));

// ─── Subject ────────────────────────────────────────────────────────────────

import { POST } from '../../../../app/pay/api/refund/route';
import { SellerNoCardRailError } from '../rails/stripe-keys';

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
  appDid: 'did:imajin:events',
  id: 'tx_original_1',
  service: 'events',
  type: 'ticket',
  fromDid: 'did:imajin:buyer',
  toDid: 'did:imajin:host',
  amount: '550.00',     // $550 = 2 × $275 tickets
  currency: 'CAD',
  status: 'completed',
  source: 'fiat',
  rail: 'stripe-byo',
  externalRef: 'cs_test_session_abc',
  metadata: { paymentIntentId: 'pi_test_original' },
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
    mocks.keysMock.mockResolvedValue({ secretKey: 'test-only-seller-key' });
    mocks.sessionMock.mockResolvedValue('pi_test_original');
    mocks.publishMock.mockResolvedValue(undefined);
  });

  it('verifies the recorded session instead of trusting forged PI metadata', async () => {
    nextSelect([{ ...BASE_TX, metadata: { paymentIntentId: 'pi_unrelated', stripePaymentIntentId: 'pi_unrelated' } }]);
    nextSelect([]);
    const res = await POST(makeRequest({ paymentId: BASE_TX.externalRef, amount: 27500 }) as never);
    expect(res.status).toBe(200);
    expect(mocks.sessionMock).toHaveBeenCalledWith('test-only-seller-key', BASE_TX.externalRef);
    expect(mocks.refundMock).toHaveBeenCalledWith({ payment_intent: 'pi_test_original', amount: 27500 });
  });
  it('returns the caller intent reference after resolving a recorded seller session', async () => {
    nextSelect([]); nextSelect([BASE_TX]); nextSelect([]);
    const res = await POST(makeRequest({ paymentId: 'pi_test_original', amount: 27500 }) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ paymentId: 'pi_test_original' });
    expect(mocks.sessionMock).toHaveBeenCalledTimes(2);
  });
  it('explains and logs unsupported legacy intent resolution without platform API calls', async () => {
    nextSelect([]); nextSelect([{ ...BASE_TX, rail: 'stripe', metadata: { paymentIntentId: 'pi_legacy' } }]);
    const res = await POST(makeRequest({ paymentId: 'pi_legacy' }) as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'REFUND_PAYMENT_UNRESOLVED', error: expect.stringContaining('legacy platform') });
    expect(mocks.logErrorMock).toHaveBeenCalled();
    expect(mocks.keysMock).not.toHaveBeenCalled();
    expect(mocks.sessionMock).not.toHaveBeenCalled();
    expect(mocks.refundMock).not.toHaveBeenCalled();
  });
  it('rejects legacy platform charges clearly without using credentials', async () => {
    nextSelect([{ ...BASE_TX, rail: 'stripe' }]);
    const res = await POST(makeRequest({ paymentId: BASE_TX.externalRef }) as any);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'LEGACY_PLATFORM_PAYMENT' });
    expect(mocks.keysMock).not.toHaveBeenCalled();
    expect(mocks.refundMock).not.toHaveBeenCalled();
  });
  it('rejects another app before reading seller keys', async () => {
    nextSelect([{ ...BASE_TX, appDid: 'did:imajin:other' }]);
    expect((await POST(makeRequest({ paymentId: BASE_TX.externalRef }) as any)).status).toBe(403);
    expect(mocks.keysMock).not.toHaveBeenCalled();
    expect(mocks.refundMock).not.toHaveBeenCalled();
  });
  it('fails with SELLER_NO_CARD_RAIL even if environment credentials are present', async () => {
    nextSelect([BASE_TX]); nextSelect([]);
    vi.stubEnv('STRIPE_SECRET_KEY', 'test-only-platform-key');
    mocks.keysMock.mockRejectedValue(new SellerNoCardRailError());
    const res = await POST(makeRequest({ paymentId: BASE_TX.externalRef }) as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'SELLER_NO_CARD_RAIL' });
    expect(mocks.refundMock).not.toHaveBeenCalled();
    expect(mocks.insertMock).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
  it('a full refund after a partial refund refunds only the remaining amount', async () => {
    nextSelect([{ ...BASE_TX, status: 'partially_refunded' }]);
    nextSelect([{ amount: '275.00' }]);
    const res = await POST(makeRequest({ paymentId: BASE_TX.externalRef }) as any);
    expect(res.status).toBe(200);
    expect(mocks.refundMock).toHaveBeenCalledWith({ payment_intent: 'pi_test_original', amount: 27500 });
    expect(mocks.setMock).toHaveBeenCalledWith({ status: 'refunded' });
  });
  it.each([0, -1, 0.5, '100'])('rejects invalid amount %j without money movement', async (amount) => {
    nextSelect([BASE_TX]);
    expect((await POST(makeRequest({ paymentId: BASE_TX.externalRef, amount }) as any)).status).toBe(400);
    expect(mocks.refundMock).not.toHaveBeenCalled();
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
    nextSelect([]);   // no tx found by externalRef
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
    nextSelect([]);          // (3) settlement txs — none (externalRef = cs_ so the checkout ref is set, but returns empty)

    const res = await POST(makeRequest({ paymentId: 'cs_test_session_abc', amount: 27500 }) as any);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactionId).toBe('tx_reversal_test');

    // Original tx should be marked partially_refunded (not fully refunded)
    expect(mocks.setMock).toHaveBeenCalledWith({ status: 'partially_refunded' });
    expect(mocks.refundMock).toHaveBeenCalledWith({
      payment_intent: 'pi_test_original',
      amount: 27500,
    });
  });

  it('writes the reversal row with rail + external_ref carrying the refund id and no stripe_id (#2176, #2650)', async () => {
    nextSelect([BASE_TX]);
    nextSelect([]);
    nextSelect([]);

    const res = await POST(makeRequest({ paymentId: 'cs_test_session_abc', amount: 27500 }) as any);
    expect(res.status).toBe(200);

    const reversal = mocks.insertValuesMock.mock.calls
      .map((c: any[]) => c[0])
      .find((v: any) => v?.type === 'refund');
    expect(reversal).toMatchObject({
      rail: 'stripe-byo',
      externalRef: 're_test_stripe',
      metadata: expect.objectContaining({ originalTxId: 'tx_original_1', originalStripeId: 'cs_test_session_abc' }),
    });
    expect(reversal).not.toHaveProperty('stripeId');
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

  it('never reverses platform settlements or changes platform balances for a BYO refund', async () => {
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
    expect(insertCall).toBeUndefined();
    expect(mocks.insertMock).toHaveBeenCalledTimes(1);
    expect(mocks.updateMock).toHaveBeenCalledTimes(1);

    // Settlement entry status → partially_refunded (not yet fully reversed)
    const statusUpdates = mocks.setMock.mock.calls.map((c: any[]) => c[0].status);
    expect(statusUpdates).toContain('partially_refunded');
  });

  it('does not update settlement entries on a final full BYO refund', async () => {
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
    expect(mocks.setMock).toHaveBeenCalledTimes(1);
  });
});
