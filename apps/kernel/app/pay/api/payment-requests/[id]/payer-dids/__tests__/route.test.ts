import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getPayerDidChoices: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));
// NOT vi.importActual: the real modules transitively import '@/src/db', which requires DATABASE_URL.
vi.mock('@/src/lib/pay/payment-requests/payer-dids', () => ({ getPayerDidChoices: mocks.getPayerDidChoices }));
vi.mock('@/src/lib/pay/payment-requests/service', () => ({
  isServiceError: (value: unknown) => typeof value === 'object' && value !== null && 'error' in value && 'status' in value,
}));

import { GET, OPTIONS } from '../route';

function callPayerDids(handle = 'ph_1') {
  return GET(new NextRequest(`https://kernel.test/pay/api/payment-requests/${handle}/payer-dids`), {
    params: Promise.resolve({ id: handle }),
  });
}

const CHOICES = {
  dids: [
    { did: 'did:imajin:eric', kind: 'personal', displayName: 'Eric' },
    { did: 'did:imajin:artifact', kind: 'organization', displayName: 'Artifact' },
  ],
  defaultDid: 'did:imajin:eric',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: { id: 'did:imajin:eric' } });
});

describe('GET /pay/api/payment-requests/:handle/payer-dids (#2656)', () => {
  it('requires authentication — 401 and nothing is looked up', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await callPayerDids();
    expect(res.status).toBe(401);
    expect(mocks.getPayerDidChoices).not.toHaveBeenCalled();
  });

  it("returns the caller's own DID plus the businesses they control, keyed by the handle in the path", async () => {
    mocks.getPayerDidChoices.mockResolvedValueOnce(CHOICES);
    const res = await callPayerDids('ph_abc');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CHOICES);
    expect(mocks.getPayerDidChoices).toHaveBeenCalledWith('ph_abc', { id: 'did:imajin:eric' });
  });

  it('passes the full identity through so an agent / acting-as caller resolves to the right person', async () => {
    const identity = { id: 'did:imajin:agent', actingFor: 'did:imajin:eric' };
    mocks.requireAuth.mockResolvedValueOnce({ identity });
    mocks.getPayerDidChoices.mockResolvedValueOnce(CHOICES);
    await callPayerDids();
    expect(mocks.getPayerDidChoices).toHaveBeenCalledWith('ph_1', identity);
  });

  it('404s an unknown or void handle', async () => {
    mocks.getPayerDidChoices.mockResolvedValueOnce({ error: 'payment_request not found', status: 404 });
    const res = await callPayerDids('nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'payment_request not found' });
  });

  it('answers 500 when the lookup throws', async () => {
    mocks.getPayerDidChoices.mockRejectedValueOnce(new Error('db down'));
    expect((await callPayerDids()).status).toBe(500);
  });

  it('answers CORS preflight', () => {
    expect(OPTIONS(new NextRequest('https://kernel.test/x', { method: 'OPTIONS' })).status).toBe(204);
  });
});
