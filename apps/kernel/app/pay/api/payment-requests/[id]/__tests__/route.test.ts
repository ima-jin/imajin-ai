import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getPaymentRequestById: vi.fn(),
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

vi.mock('@/src/lib/pay/payment-requests/service', () => ({
  getPaymentRequestById: mocks.getPaymentRequestById,
}));

import { GET } from '../route';

const ISSUER_DID = 'did:imajin:issuer';
const RECIPIENT_DID = 'did:imajin:recipient';
const OTHER_DID = 'did:imajin:other';

function req(): NextRequest {
  return new NextRequest('https://kernel.test/pay/api/payment-requests/pr_1');
}

function callGet(id = 'pr_1') {
  return GET(req(), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: { id: ISSUER_DID } });
});

describe('GET /pay/api/payment-requests/:id', () => {
  it('fails closed on auth failure', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await callGet();
    expect(res.status).toBe(401);
  });

  it('returns 404 when not found', async () => {
    mocks.getPaymentRequestById.mockResolvedValueOnce(null);
    const res = await callGet();
    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller is neither issuer nor recipient', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ identity: { id: OTHER_DID } });
    mocks.getPaymentRequestById.mockResolvedValueOnce({ id: 'pr_1', issuerDid: ISSUER_DID, recipientDid: RECIPIENT_DID });
    const res = await callGet();
    expect(res.status).toBe(403);
  });

  it('allows the issuer to view it', async () => {
    mocks.getPaymentRequestById.mockResolvedValueOnce({ id: 'pr_1', issuerDid: ISSUER_DID, recipientDid: RECIPIENT_DID });
    const res = await callGet();
    expect(res.status).toBe(200);
  });

  it('allows the recipient to view it', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ identity: { id: RECIPIENT_DID } });
    mocks.getPaymentRequestById.mockResolvedValueOnce({ id: 'pr_1', issuerDid: ISSUER_DID, recipientDid: RECIPIENT_DID });
    const res = await callGet();
    expect(res.status).toBe(200);
  });
});
