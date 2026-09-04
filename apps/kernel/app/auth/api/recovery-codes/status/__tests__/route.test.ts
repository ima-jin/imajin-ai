import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getRecoveryCodeStatus: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  withLogger:
    (_service: string, handler: (req: unknown, ctx: { log: unknown }) => unknown) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => ({}),
}));

vi.mock('@/src/lib/auth/middleware', () => ({
  requireAuth: h.requireAuth,
}));

vi.mock('@/src/lib/auth/recovery-codes', () => ({
  getRecoveryCodeStatus: h.getRecoveryCodeStatus,
}));

import { GET, OPTIONS } from '../route';

function makeReq(): NextRequest {
  return { headers: new Headers() } as unknown as NextRequest;
}

const DID = 'did:imajin:self-custody-user';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /auth/api/recovery-codes/status', () => {
  it('requires authentication', async () => {
    h.requireAuth.mockResolvedValue(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(h.getRecoveryCodeStatus).not.toHaveBeenCalled();
  });

  it('returns remaining count and generatedAt for the authenticated identity, never codes', async () => {
    h.requireAuth.mockResolvedValue({ sub: DID });
    h.getRecoveryCodeStatus.mockResolvedValue({ remaining: 7, generatedAt: '2026-01-01T00:00:00.000Z' });

    const res = await GET(makeReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ did: DID, remaining: 7, generatedAt: '2026-01-01T00:00:00.000Z' });
    expect(h.getRecoveryCodeStatus).toHaveBeenCalledWith(DID);
  });

  it('reports zero remaining when no codes have ever been generated', async () => {
    h.requireAuth.mockResolvedValue({ sub: DID });
    h.getRecoveryCodeStatus.mockResolvedValue({ remaining: 0, generatedAt: null });

    const res = await GET(makeReq());
    const body = await res.json();

    expect(body).toEqual({ did: DID, remaining: 0, generatedAt: null });
  });

  it('returns a 500 when the status lookup throws', async () => {
    h.requireAuth.mockResolvedValue({ sub: DID });
    h.getRecoveryCodeStatus.mockRejectedValue(new Error('db unavailable'));

    const res = await GET(makeReq());
    expect(res.status).toBe(500);
  });
});

describe('OPTIONS /auth/api/recovery-codes/status', () => {
  it('responds with 204 for CORS preflight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });
});
