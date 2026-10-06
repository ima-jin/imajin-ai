import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  settlePaymentRequestManual: vi.fn(),
  settlePaymentRequestEmt: vi.fn(),
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

// Same reason as the service mock above: the real module pulls in '@/src/db'.
vi.mock('@/src/lib/pay/payment-requests/emt', () => ({
  settlePaymentRequestEmt: mocks.settlePaymentRequestEmt,
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

  it('rejects methods other than manual/emt (stripe/mjnx reserved for #2209)', async () => {
    for (const method of ['stripe', 'mjnx', undefined]) {
      const res = await callSettle({ method });
      expect(res.status).toBe(400);
    }
    expect(mocks.settlePaymentRequestManual).not.toHaveBeenCalled();
    expect(mocks.settlePaymentRequestEmt).not.toHaveBeenCalled();
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

describe("POST /pay/api/payment-requests/:id/settle {method: 'emt'} — Mark paid (e-Transfer) (#2665)", () => {
  it('fails closed on auth failure and never reaches the service', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await callSettle({ method: 'emt' });
    expect(res.status).toBe(401);
    expect(mocks.settlePaymentRequestEmt).not.toHaveBeenCalled();
  });

  it('delegates to the e-Transfer service (not the manual one) with the resolved caller DID', async () => {
    mocks.settlePaymentRequestEmt.mockResolvedValueOnce({ paymentRequest: { id: 'pr_1', status: 'paid' }, settled: true });
    const res = await callSettle({ method: 'emt' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settled: true, paymentRequest: { status: 'paid' } });
    expect(mocks.settlePaymentRequestEmt).toHaveBeenCalledWith({ id: 'pr_1', callerDid: ISSUER_DID });
    expect(mocks.settlePaymentRequestManual).not.toHaveBeenCalled();
  });

  it("passes the ACTING business DID as the caller when someone acts for the issuer (resolveActingDid)", async () => {
    mocks.requireAuth.mockResolvedValueOnce({ identity: { id: 'did:imajin:delegate', actingFor: ISSUER_DID } });
    mocks.settlePaymentRequestEmt.mockResolvedValueOnce({ paymentRequest: { id: 'pr_1' }, settled: true });
    await callSettle({ method: 'emt' });
    expect(mocks.settlePaymentRequestEmt).toHaveBeenCalledWith({ id: 'pr_1', callerDid: ISSUER_DID });
  });

  it('maps an unauthorized attempt (the service refuses a non-issuer) to a 403 — enforced server-side, not by the client', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ identity: { id: 'did:imajin:stranger' } });
    mocks.settlePaymentRequestEmt.mockResolvedValueOnce({
      error: 'only the issuer, or someone acting for the issuer business, may mark this payment_request paid',
      status: 403,
    });

    const res = await callSettle({ method: 'emt' });

    expect(res.status).toBe(403);
    expect(mocks.settlePaymentRequestEmt).toHaveBeenCalledWith({ id: 'pr_1', callerDid: 'did:imajin:stranger' });
  });

  it('a replay answers 200 with settled: false (idempotent), and a request already settled another way is a 409', async () => {
    mocks.settlePaymentRequestEmt.mockResolvedValueOnce({ paymentRequest: { id: 'pr_1', status: 'paid' }, settled: false });
    const replay = await callSettle({ method: 'emt' });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ settled: false });

    mocks.settlePaymentRequestEmt.mockResolvedValueOnce({ error: "cannot mark a payment_request in status 'paid' paid by e-Transfer", status: 409 });
    expect((await callSettle({ method: 'emt' })).status).toBe(409);
  });

  it('answers 500 when the service throws', async () => {
    mocks.settlePaymentRequestEmt.mockRejectedValueOnce(new Error('boom'));
    expect((await callSettle({ method: 'emt' })).status).toBe(500);
  });
});
