import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requestEmtPayInstructions: vi.fn(),
  rateLimit: vi.fn(),
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
vi.mock('@/src/lib/pay/payment-requests/emt', () => ({ requestEmtPayInstructions: mocks.requestEmtPayInstructions }));

import { POST, OPTIONS } from '../route';

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

  it('answers CORS preflight', () => {
    expect(OPTIONS(new NextRequest('https://kernel.test/x', { method: 'OPTIONS' })).status).toBe(204);
  });
});
