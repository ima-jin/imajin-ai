import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requestEmtPayInstructions: vi.fn(),
  revertEmtPending: vi.fn(),
  rateLimit: vi.fn(),
  requireAuth: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/src/lib/pay/payment-requests/payer-dids', () => ({
  payerPersonDidOf: (identity: { actingFor?: string; id: string }) => identity.actingFor ?? identity.id,
}));
vi.mock('@imajin/config', () => ({
  rateLimit: mocks.rateLimit,
  getClientIP: () => '203.0.113.7',
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));
// NOT vi.importActual: the real modules transitively import '@/src/db'.
vi.mock('@/src/lib/pay/payment-requests/service', () => ({
  isServiceError: (value: unknown) => typeof value === 'object' && value !== null && 'error' in value && 'status' in value,
}));
vi.mock('@/src/lib/pay/payment-requests/emt', () => ({
  requestEmtPayInstructions: mocks.requestEmtPayInstructions,
  revertEmtPending: mocks.revertEmtPending,
}));

import { POST, DELETE, OPTIONS } from '../route';

function callEmt(handle = 'ph_1') {
  return POST(
    new NextRequest(`https://kernel.test/pay/api/payment-requests/by-handle/${handle}/emt`, { method: 'POST' }),
    { params: Promise.resolve({ handle }) },
  );
}

const INSTRUCTIONS = { rail: 'emt', destination: 'pay@acme.example', amountMinor: 1999, currency: 'CAD', reference: 'INV-0123456789' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockReturnValue({ limited: false });
});

describe('POST /pay/api/payment-requests/by-handle/:handle/emt (#2665)', () => {
  it('needs no auth — the pay link is the capability — and returns { email, amount, memo } plus the exact minor-unit amount', async () => {
    mocks.requestEmtPayInstructions.mockResolvedValueOnce({ instructions: INSTRUCTIONS, alreadyPending: false });

    const res = await callEmt();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      already_pending: false,
      instructions: { email: 'pay@acme.example', amount: 19.99, amountMinor: 1999, currency: 'CAD', memo: 'INV-0123456789' },
    });
    expect(mocks.requestEmtPayInstructions).toHaveBeenCalledWith('ph_1');
  });

  it('flags a repeat call as already_pending (idempotent — same instructions again)', async () => {
    mocks.requestEmtPayInstructions.mockResolvedValueOnce({ instructions: INSTRUCTIONS, alreadyPending: true });
    const body = await (await callEmt()).json();
    expect(body.already_pending).toBe(true);
    expect(body.instructions.memo).toBe('INV-0123456789');
  });

  it.each([
    [404, 'payment_request not found'],
    [409, "cannot pay a payment_request in status 'paid' by e-Transfer"],
    [400, 'e-Transfer is not available for this payment_request'],
  ])('passes a %i service error straight through', async (status, error) => {
    mocks.requestEmtPayInstructions.mockResolvedValueOnce({ error, status });
    const res = await callEmt();
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });

  it('is rate limited per client IP — a 429 with Retry-After, and the service is never reached', async () => {
    mocks.rateLimit.mockReturnValueOnce({ limited: true, retryAfter: 42 });
    const res = await callEmt();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(mocks.requestEmtPayInstructions).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledWith('203.0.113.7', 10, 60_000);
  });

  it('answers 500 when the service throws', async () => {
    mocks.requestEmtPayInstructions.mockRejectedValueOnce(new Error('db down'));
    expect((await callEmt()).status).toBe(500);
  });

  describe('payer DID choice (#2656)', () => {
    function callEmtWithBody(body: string) {
      return POST(
        new NextRequest('https://kernel.test/pay/api/payment-requests/by-handle/ph_1/emt', {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/json' },
        }),
        { params: Promise.resolve({ handle: 'ph_1' }) },
      );
    }

    it('an anonymous call with an empty-object body (no paidByDid) still needs no auth', async () => {
      mocks.requestEmtPayInstructions.mockResolvedValueOnce({ instructions: INSTRUCTIONS, alreadyPending: false });
      const res = await callEmtWithBody('{}');
      expect(res.status).toBe(200);
      expect(mocks.requireAuth).not.toHaveBeenCalled();
      expect(mocks.requestEmtPayInstructions).toHaveBeenCalledWith('ph_1');
    });

    it('naming a paidByDid requires a signed-in caller — 401 otherwise, and the service is never reached', async () => {
      mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
      const res = await callEmtWithBody(JSON.stringify({ paidByDid: 'did:imajin:artifact' }));
      expect(res.status).toBe(401);
      expect(mocks.requestEmtPayInstructions).not.toHaveBeenCalled();
    });

    it("passes the choice plus the signed-in person's DID to the service", async () => {
      mocks.requireAuth.mockResolvedValueOnce({ identity: { id: 'did:imajin:eric' } });
      mocks.requestEmtPayInstructions.mockResolvedValueOnce({ instructions: INSTRUCTIONS, alreadyPending: false });
      const res = await callEmtWithBody(JSON.stringify({ paidByDid: 'did:imajin:artifact' }));
      expect(res.status).toBe(200);
      expect(mocks.requestEmtPayInstructions).toHaveBeenCalledWith('ph_1', {
        paidByDid: 'did:imajin:artifact',
        personDid: 'did:imajin:eric',
      });
    });

    it('a DID the person cannot act for is a 403 straight from the service', async () => {
      mocks.requireAuth.mockResolvedValueOnce({ identity: { id: 'did:imajin:eric' } });
      mocks.requestEmtPayInstructions.mockResolvedValueOnce({ error: 'You are not authorized to pay as that identity', status: 403 });
      const res = await callEmtWithBody(JSON.stringify({ paidByDid: 'did:imajin:someone-elses' }));
      expect(res.status).toBe(403);
    });

    it('rejects a non-string paidByDid and an unparseable body with 400', async () => {
      expect((await callEmtWithBody(JSON.stringify({ paidByDid: 42 }))).status).toBe(400);
      expect((await callEmtWithBody('{not json')).status).toBe(400);
      expect(mocks.requestEmtPayInstructions).not.toHaveBeenCalled();
    });
  });

  it('answers CORS preflight', () => {
    expect(OPTIONS(new NextRequest('https://kernel.test/x', { method: 'OPTIONS' })).status).toBe(204);
  });
});

describe('DELETE /pay/api/payment-requests/by-handle/:handle/emt — "Pay another way" (#2758)', () => {
  function callLeave(handle = 'ph_1') {
    return DELETE(
      new NextRequest(`https://kernel.test/pay/api/payment-requests/by-handle/${handle}/emt`, { method: 'DELETE' }),
      { params: Promise.resolve({ handle }) },
    );
  }

  it('needs no auth — the pay link is the capability — and reports the reverted status', async () => {
    mocks.revertEmtPending.mockResolvedValueOnce({ paymentRequest: { status: 'issued' }, reverted: true });

    const res = await callLeave();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, reverted: true, status: 'issued' });
    expect(mocks.revertEmtPending).toHaveBeenCalledWith('ph_1');
    expect(mocks.requireAuth).not.toHaveBeenCalled();
  });

  it('is idempotent: a request already back at issued is a 200 with reverted: false', async () => {
    mocks.revertEmtPending.mockResolvedValueOnce({ paymentRequest: { status: 'issued' }, reverted: false });

    const res = await callLeave();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reverted: false, status: 'issued' });
  });

  it.each([
    [404, 'payment_request not found'],
    [409, "cannot leave e-Transfer on a payment_request in status 'paid' — a payment has already been confirmed"],
  ])('passes a %i service error straight through (a confirmed deposit is a 409)', async (status, error) => {
    mocks.revertEmtPending.mockResolvedValueOnce({ error, status });

    const res = await callLeave();

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });

  it('shares the choice\'s per-IP rate limit — a 429 with Retry-After, and the service is never reached', async () => {
    mocks.rateLimit.mockReturnValueOnce({ limited: true, retryAfter: 17 });

    const res = await callLeave();

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('17');
    expect(mocks.revertEmtPending).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledWith('203.0.113.7', 10, 60_000);
  });

  it('answers 500 when the service throws', async () => {
    mocks.revertEmtPending.mockRejectedValueOnce(new Error('db down'));

    expect((await callLeave()).status).toBe(500);
  });
});
