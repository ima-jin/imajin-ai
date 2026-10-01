/**
 * Tests for POST /pay/api/admin/payment-requests/:id/retry-settlement
 * (#2439 — the operator's retry path for `payment_request.settlement_failed`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  retry: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

// NOT vi.importActual: the real modules transitively import '@/src/db',
// which requires DATABASE_URL (same rationale as the sibling route tests).
vi.mock('@/src/lib/pay/payment-requests/checkout', () => ({ retryPaymentRequestStripeSettlement: mocks.retry }));
vi.mock('@/src/lib/pay/payment-requests/service', () => ({
  isServiceError: (value: unknown) => typeof value === 'object' && value !== null && 'error' in value && 'status' in value,
}));

import { POST } from '../route';

function call(id = 'pr_1') {
  return POST(new Request(`https://kernel.test/pay/api/admin/payment-requests/${id}/retry-settlement`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ actingAs: 'did:imajin:node' });
});

describe('POST /pay/api/admin/payment-requests/:id/retry-settlement', () => {
  it('401s for a non-admin and never retries', async () => {
    mocks.requireAdmin.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it('retries the settlement for the path id and reports success', async () => {
    mocks.retry.mockResolvedValue({ paymentRequest: { id: 'pr_1' }, settled: true });
    const res = await call('pr_1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paymentRequestId: 'pr_1', settled: true });
    expect(mocks.retry).toHaveBeenCalledWith('pr_1');
  });

  it.each([
    [404, 'payment_request not found'],
    [409, 'payment_request already has settlement ledger rows — refusing to settle twice'],
    [422, 'settlement retry failed (basis_mismatch): taxes[].basisAmount (4000) does not match subtotalAmount (5000)'],
  ])('passes a %i service error through with its message', async (status, error) => {
    mocks.retry.mockResolvedValue({ error, status });
    const res = await call();
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });

  it('maps an unexpected throw to a 500', async () => {
    mocks.retry.mockRejectedValue(new Error('db down'));
    const res = await call();
    expect(res.status).toBe(500);
  });
});
