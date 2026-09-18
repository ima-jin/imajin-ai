/**
 * Tests for POST /api/balance/withdraw (#2016, #2166, #2172).
 *
 * #2172 rewrote the route to reserve -> external -> confirm via
 * `executeWithdrawal` (`src/lib/pay/withdraw-intent.ts`) and a registered
 * `WithdrawRail` (`src/lib/pay/rails/registry.ts`), instead of one
 * `db.transaction()` wrapping a private inline Stripe client. These tests
 * therefore mock `executeWithdrawal`/`defaultRailForUnit` directly rather
 * than the DB/Stripe mocking `mock-drizzle-table.ts` provides for the
 * older single-transaction shape — the transactional/crash-injection
 * behavior itself is covered at the `withdraw-intent.ts` unit-test level
 * (`../../../../../src/lib/pay/__tests__/withdraw-intent.test.ts`), not
 * re-verified here. This suite only asserts the route's own contract:
 * validation, status-code mapping, and response shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InsufficientBalanceError, MJN } from '@/src/lib/pay/ledger';

const state = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  executeWithdrawalMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: { log: unknown }) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: { error: () => {}, info: () => {}, warn: () => {} } }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: state.requireAuthMock,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

// `../route` imports `InsufficientBalanceError`/`MJN` from `@/src/lib/pay/ledger`,
// which imports the real `@/src/db` at module load time (eagerly constructing a
// DB client) unless stubbed — same reason every other pay route suite in this
// codebase mocks `@/src/db` even when the route itself no longer touches it directly.
vi.mock('@/src/db', () => ({ db: {}, balances: {}, transactions: {}, withdrawalIntents: {} }));

vi.mock('@/src/lib/pay/withdraw-intent', () => ({
  executeWithdrawal: state.executeWithdrawalMock,
}));

vi.mock('@/src/lib/pay/rails/registry', () => ({
  defaultRailForUnit: () => ({ name: 'fake' }),
}));

import { POST, OPTIONS } from '../route';

const DID = 'did:imajin:owner';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/api/balance/withdraw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.requireAuthMock.mockResolvedValue({ identity: { id: DID } });
});

describe('OPTIONS /api/balance/withdraw', () => {
  it('returns a 204 CORS preflight response', async () => {
    const res = await OPTIONS(makeRequest({}) as never);
    expect(res.status).toBe(204);
  });
});

describe('POST /api/balance/withdraw — MJN-only, reserve -> external -> confirm (#2172)', () => {
  it('returns 401 when the caller is not authenticated', async () => {
    state.requireAuthMock.mockResolvedValueOnce({ error: 'no session' });

    const res = await POST(makeRequest({ amount: 500, account_id: 'acct_1' }) as never);

    expect(res.status).toBe(401);
    expect(state.executeWithdrawalMock).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric/non-positive amount without ever calling executeWithdrawal', async () => {
    const res = await POST(makeRequest({ amount: -5, account_id: 'acct_1' }) as never);
    expect(res.status).toBe(400);
    expect(state.executeWithdrawalMock).not.toHaveBeenCalled();
  });

  it('rejects an amount below the minimum without ever calling executeWithdrawal', async () => {
    const res = await POST(makeRequest({ amount: 1, account_id: 'acct_1' }) as never);
    expect(res.status).toBe(400);
    expect(state.executeWithdrawalMock).not.toHaveBeenCalled();
  });

  it('rejects a missing account_id without ever calling executeWithdrawal', async () => {
    const res = await POST(makeRequest({ amount: 500 }) as never);
    expect(res.status).toBe(400);
    expect(state.executeWithdrawalMock).not.toHaveBeenCalled();
  });

  it('maps InsufficientBalanceError to 402 (the reservation guard failed — no rail was ever called)', async () => {
    state.executeWithdrawalMock.mockRejectedValueOnce(new InsufficientBalanceError(MJN));

    const res = await POST(makeRequest({ amount: 500, account_id: 'acct_1' }) as never);

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/Insufficient MJN balance/);
  });

  it('returns 200 with the confirmed transaction/external ref on success', async () => {
    state.executeWithdrawalMock.mockResolvedValueOnce({
      intent: { id: 'wdi_1', did: DID, unit: MJN, amount: '5', rail: 'fake', idempotencyKey: 'wdi_1' },
      externalRef: 'fake_tr_1',
      transactionId: 'tx_1',
    });

    const res = await POST(makeRequest({ amount: 500, account_id: 'acct_1' }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      transactionId: 'tx_1',
      transferId: 'fake_tr_1',
      amount: 500,
      currency: 'CAD',
    });

    expect(state.executeWithdrawalMock).toHaveBeenCalledWith(
      expect.objectContaining({ did: DID, unit: MJN, amount: 5, currency: 'CAD', destination: 'acct_1' }),
    );
  });

  it('maps any other executeWithdrawal failure (e.g. the rail threw, reservation already released) to 500', async () => {
    state.executeWithdrawalMock.mockRejectedValueOnce(new Error('rail down'));

    const res = await POST(makeRequest({ amount: 500, account_id: 'acct_1' }) as never);

    expect(res.status).toBe(500);
  });
});

describe('POST /api/balance/withdraw — no rail configured for the unit', () => {
  it('returns 500 without ever calling executeWithdrawal when no rail is registered for MJN', async () => {
    vi.resetModules();
    vi.doMock('@/src/lib/pay/rails/registry', () => ({ defaultRailForUnit: () => null }));
    const { POST: postWithNoRail } = await import('../route');

    const res = await postWithNoRail(makeRequest({ amount: 500, account_id: 'acct_1' }) as never);

    expect(res.status).toBe(500);
    expect(state.executeWithdrawalMock).not.toHaveBeenCalled();
  });
});
