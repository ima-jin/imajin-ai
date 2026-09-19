import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  voidPaymentRequest: vi.fn(),
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
  voidPaymentRequest: mocks.voidPaymentRequest,
}));

import { POST } from '../route';

const ISSUER_DID = 'did:imajin:issuer';

function callVoid(id = 'pr_1') {
  return POST(new NextRequest('https://kernel.test/pay/api/payment-requests/pr_1/void', { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: { id: ISSUER_DID } });
});

describe('POST /pay/api/payment-requests/:id/void', () => {
  it('fails closed on auth failure', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await callVoid();
    expect(res.status).toBe(401);
    expect(mocks.voidPaymentRequest).not.toHaveBeenCalled();
  });

  it('delegates to the service with the resolved caller DID', async () => {
    mocks.voidPaymentRequest.mockResolvedValueOnce({ id: 'pr_1', status: 'void' });
    const res = await callVoid();
    expect(res.status).toBe(200);
    expect(mocks.voidPaymentRequest).toHaveBeenCalledWith({ id: 'pr_1', callerDid: ISSUER_DID });
  });

  it('maps a 403 issuer-only rejection through', async () => {
    mocks.voidPaymentRequest.mockResolvedValueOnce({ error: 'only the issuer may void this payment_request', status: 403 });
    const res = await callVoid();
    expect(res.status).toBe(403);
  });

  it('maps a 409 status-conflict rejection through', async () => {
    mocks.voidPaymentRequest.mockResolvedValueOnce({ error: "cannot void a payment_request in status 'void'", status: 409 });
    const res = await callVoid();
    expect(res.status).toBe(409);
  });
});
