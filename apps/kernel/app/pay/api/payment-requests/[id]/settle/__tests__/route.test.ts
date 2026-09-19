import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  settlePaymentRequestManual: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuth,
  resolveActingDid: (identity: { actingFor?: string; id: string }) => identity.actingFor ?? identity.id,
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));

// NOT vi.importActual: the real module transitively imports '@/src/db',
// which requires DATABASE_URL to be set. isServiceError is trivial enough
// to reimplement inline instead.
vi.mock('@/src/lib/pay/payment-requests/service', () => ({
  isServiceError: (value: unknown) => typeof value === 'object' && value !== null && 'error' in value && 'status' in value,
  settlePaymentRequestManual: mocks.settlePaymentRequestManual,
}));

import { POST } from '../route';

const ISSUER_DID = 'did:imajin:issuer';

function callSettle(body: unknown, id = 'pr_1') {
  return POST(
    new NextRequest('https://kernel.test/pay/api/payment-requests/pr_1/settle', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: { id: ISSUER_DID } });
});

describe('POST /pay/api/payment-requests/:id/settle', () => {
  it('fails closed on auth failure', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await callSettle({ method: 'manual' });
    expect(res.status).toBe(401);
  });

  it('rejects a non-manual method (stripe/mjnx reserved for #2209)', async () => {
    const res = await callSettle({ method: 'stripe' });
    expect(res.status).toBe(400);
    expect(mocks.settlePaymentRequestManual).not.toHaveBeenCalled();
  });

  it('rejects a non-string note', async () => {
    const res = await callSettle({ method: 'manual', note: 123 });
    expect(res.status).toBe(400);
  });

  it('delegates to the service and returns 200 on success', async () => {
    mocks.settlePaymentRequestManual.mockResolvedValueOnce({ id: 'pr_1', status: 'settled_manual' });
    const res = await callSettle({ method: 'manual', note: 'paid via e-transfer' });
    expect(res.status).toBe(200);
    expect(mocks.settlePaymentRequestManual).toHaveBeenCalledWith({ id: 'pr_1', callerDid: ISSUER_DID, note: 'paid via e-transfer' });
  });

  it('maps a 409 status-conflict rejection through (idempotent replay)', async () => {
    mocks.settlePaymentRequestManual.mockResolvedValueOnce({ error: "cannot settle a payment_request in status 'settled_manual'", status: 409 });
    const res = await callSettle({ method: 'manual' });
    expect(res.status).toBe(409);
  });
});
