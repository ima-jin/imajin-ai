import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), getIssuerPayRails: vi.fn() }));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuth,
  resolveActingDid: (identity: { actingFor?: string; id: string }) => identity.actingFor ?? identity.id,
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/pay/payment-requests/issuer-rails', () => ({ getIssuerPayRails: mocks.getIssuerPayRails }));

import { GET, OPTIONS } from '../route';

const ISSUER = 'did:imajin:imajin-inc';

function call(query = `?issuer_did=${ISSUER}`) {
  return GET(new NextRequest(`https://kernel.test/pay/api/payment-requests/rails${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: { id: ISSUER } });
});

describe('GET /pay/api/payment-requests/rails (#2754)', () => {
  it('returns only the two booleans for the signed-in issuer', async () => {
    mocks.getIssuerPayRails.mockResolvedValue({ card: false, emt: true });

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ card: false, emt: true });
    expect(mocks.getIssuerPayRails).toHaveBeenCalledWith(ISSUER);
  });

  it('401s an unauthenticated caller and reads nothing', async () => {
    mocks.requireAuth.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    expect((await call()).status).toBe(401);
    expect(mocks.getIssuerPayRails).not.toHaveBeenCalled();
  });

  it('400s a missing issuer_did', async () => {
    expect((await call('')).status).toBe(400);
    expect(mocks.getIssuerPayRails).not.toHaveBeenCalled();
  });

  it('403s an issuer_did that is not the authenticated principal — nobody reads another issuer\'s rails', async () => {
    expect((await call('?issuer_did=did:imajin:someone-else')).status).toBe(403);
    expect(mocks.getIssuerPayRails).not.toHaveBeenCalled();
  });

  it('acts as the business DID when the caller is acting for one', async () => {
    mocks.requireAuth.mockResolvedValue({ identity: { id: 'did:imajin:eric', actingFor: ISSUER } });
    mocks.getIssuerPayRails.mockResolvedValue({ card: true, emt: false });

    expect((await call()).status).toBe(200);
    expect(mocks.getIssuerPayRails).toHaveBeenCalledWith(ISSUER);
  });

  it('answers 500 when the read throws', async () => {
    mocks.getIssuerPayRails.mockRejectedValue(new Error('db down'));

    expect((await call()).status).toBe(500);
  });

  it('answers the CORS preflight', () => {
    expect(OPTIONS(new NextRequest('https://kernel.test/pay/api/payment-requests/rails', { method: 'OPTIONS' })).status).toBe(204);
  });
});
