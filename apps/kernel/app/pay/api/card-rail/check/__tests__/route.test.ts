import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  resolveCardRailMock: vi.fn(),
  rateLimitMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock('@/src/lib/pay/payment-requests/card-rail', () => ({ resolveCardRail: h.resolveCardRailMock }));
vi.mock('@imajin/config', () => ({ rateLimit: h.rateLimitMock, getClientIP: () => '127.0.0.1' }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': '*' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: { log: unknown }) => Promise<Response>) => (req: unknown) =>
    handler(req, { log: { info: vi.fn(), warn: vi.fn(), error: h.errorMock } }),
}));

import { GET } from '../route';

const DID = 'did:imajin:organizer';

function get(query = `?did=${encodeURIComponent(DID)}`): NextRequest {
  return new Request(`https://kernel.test/pay/api/card-rail/check${query}`) as unknown as NextRequest;
}

beforeEach(() => {
  h.resolveCardRailMock.mockReset().mockResolvedValue({ kind: 'none' });
  h.rateLimitMock.mockReset().mockReturnValue({ limited: false });
  h.errorMock.mockReset();
});

describe('GET /pay/api/card-rail/check (#2757 — replaces /connect/check)', () => {
  it('reports cardEnabled true when the seller has a connector rail', async () => {
    h.resolveCardRailMock.mockResolvedValue({ kind: 'connector', ownerDid: DID });

    const res = await GET(get());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cardEnabled: true });
    expect(h.resolveCardRailMock).toHaveBeenCalledWith(DID);
  });

  it('reports cardEnabled false when the seller has no card rail — and nothing else about them', async () => {
    const res = await GET(get());

    expect(await res.json()).toEqual({ cardEnabled: false });
  });

  it('requires a did', async () => {
    const res = await GET(get(''));

    expect(res.status).toBe(400);
    expect(h.resolveCardRailMock).not.toHaveBeenCalled();
  });

  it('is rate limited', async () => {
    h.rateLimitMock.mockReturnValue({ limited: true, retryAfter: 12 });

    const res = await GET(get());

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('12');
    expect(h.resolveCardRailMock).not.toHaveBeenCalled();
  });

  it('answers 500 (logged) if the rail lookup throws', async () => {
    h.resolveCardRailMock.mockRejectedValue(new Error('boom'));

    const res = await GET(get());

    expect(res.status).toBe(500);
    expect(h.errorMock).toHaveBeenCalled();
  });
});
