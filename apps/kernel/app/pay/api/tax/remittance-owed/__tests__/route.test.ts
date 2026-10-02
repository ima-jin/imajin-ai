import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getTaxRemittanceOwed: vi.fn(),
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
// which requires DATABASE_URL to be set (same rationale as the sibling
// payment-requests route test).
vi.mock('@/src/lib/pay/tax-remittance', () => ({
  getTaxRemittanceOwed: mocks.getTaxRemittanceOwed,
}));

import { GET } from '../route';

const COLLECTOR_DID = 'did:imajin:seller-business';

function getReq(query: string): NextRequest {
  return new NextRequest(`https://kernel.test/pay/api/tax/remittance-owed${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: { id: COLLECTOR_DID } });
});

describe('GET /pay/api/tax/remittance-owed', () => {
  it('fails closed on auth failure', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await GET(getReq(`?collector_did=${COLLECTOR_DID}`));
    expect(res.status).toBe(401);
    expect(mocks.getTaxRemittanceOwed).not.toHaveBeenCalled();
  });

  it('requires collector_did', async () => {
    const res = await GET(getReq(''));
    expect(res.status).toBe(400);
    expect(mocks.getTaxRemittanceOwed).not.toHaveBeenCalled();
  });

  it("rejects collector_did that doesn't match the caller (business-scoped)", async () => {
    const res = await GET(getReq('?collector_did=did:imajin:someone-else'));
    expect(res.status).toBe(403);
    expect(mocks.getTaxRemittanceOwed).not.toHaveBeenCalled();
  });

  it('returns owed amounts for the caller\u2019s own collector_did', async () => {
    mocks.getTaxRemittanceOwed.mockResolvedValueOnce([{ jurisdiction: 'CA-ON', kind: 'GST/HST', registrationNumber: '123456789RT0001', amount: 13 }]);
    const res = await GET(getReq(`?collector_did=${COLLECTOR_DID}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    // #2439: the registration number rides next to what's owed.
    expect(body.owed).toEqual([{ jurisdiction: 'CA-ON', kind: 'GST/HST', registrationNumber: '123456789RT0001', amount: 13 }]);
    expect(mocks.getTaxRemittanceOwed).toHaveBeenCalledWith(COLLECTOR_DID);
  });

  it('maps a query error to a 500', async () => {
    mocks.getTaxRemittanceOwed.mockRejectedValueOnce(new Error('db down'));
    const res = await GET(getReq(`?collector_did=${COLLECTOR_DID}`));
    expect(res.status).toBe(500);
  });
});
