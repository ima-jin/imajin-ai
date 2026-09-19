import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  createPaymentRequest: vi.fn(),
  listPaymentRequests: vi.fn(),
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
  createPaymentRequest: mocks.createPaymentRequest,
  listPaymentRequests: mocks.listPaymentRequests,
}));

import { POST, GET } from '../route';

const ISSUER_DID = 'did:imajin:issuer';

function postReq(body: unknown): NextRequest {
  return new NextRequest('https://kernel.test/pay/api/payment-requests', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function getReq(query: string): NextRequest {
  return new NextRequest(`https://kernel.test/pay/api/payment-requests${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: { id: ISSUER_DID } });
});

describe('POST /pay/api/payment-requests', () => {
  it('fails closed on auth failure', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await POST(postReq({ issuer_did: ISSUER_DID }));
    expect(res.status).toBe(401);
    expect(mocks.createPaymentRequest).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON', async () => {
    const req = new NextRequest('https://kernel.test/pay/api/payment-requests', { method: 'POST', body: '{bad', headers: { 'content-type': 'application/json' } });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('delegates to the service with snake_case body mapped to camelCase, and returns 201', async () => {
    mocks.createPaymentRequest.mockResolvedValueOnce({ id: 'pr_1', status: 'issued' });

    const res = await POST(postReq({
      issuer_did: ISSUER_DID,
      recipient_did: 'did:imajin:recipient',
      line_items: [{ name: 'Item', amount: 100, quantity: 1 }],
      due_at: '2026-01-01T00:00:00.000Z',
    }));

    expect(res.status).toBe(201);
    expect(mocks.createPaymentRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        callerDid: ISSUER_DID,
        issuerDid: ISSUER_DID,
        recipientDid: 'did:imajin:recipient',
        lineItems: [{ name: 'Item', amount: 100, quantity: 1 }],
        dueAt: '2026-01-01T00:00:00.000Z',
      }),
    );
  });

  it('maps a service error to its HTTP status', async () => {
    mocks.createPaymentRequest.mockResolvedValueOnce({ error: 'issuer_did must resolve to the authenticated principal', status: 403 });
    const res = await POST(postReq({ issuer_did: 'did:imajin:someone-else' }));
    expect(res.status).toBe(403);
  });
});

describe('GET /pay/api/payment-requests', () => {
  it('fails closed on auth failure', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await GET(getReq(`?issuer_did=${ISSUER_DID}`));
    expect(res.status).toBe(401);
  });

  it('requires issuer_did or recipient_did', async () => {
    const res = await GET(getReq(''));
    expect(res.status).toBe(400);
    expect(mocks.listPaymentRequests).not.toHaveBeenCalled();
  });

  it("rejects issuer_did that doesn't match the caller", async () => {
    const res = await GET(getReq('?issuer_did=did:imajin:someone-else'));
    expect(res.status).toBe(403);
  });

  it('lists by issuer_did when it matches the caller', async () => {
    mocks.listPaymentRequests.mockResolvedValueOnce([{ id: 'pr_1' }]);
    const res = await GET(getReq(`?issuer_did=${ISSUER_DID}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paymentRequests).toEqual([{ id: 'pr_1' }]);
  });

  it('lists by recipient_did when it matches the caller', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ identity: { id: 'did:imajin:recipient' } });
    mocks.listPaymentRequests.mockResolvedValueOnce([]);
    const res = await GET(getReq('?recipient_did=did:imajin:recipient'));
    expect(res.status).toBe(200);
  });
});
