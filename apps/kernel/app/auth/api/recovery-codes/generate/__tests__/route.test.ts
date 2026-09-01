import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  generateRecoveryCodes: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  withLogger:
    (_service: string, handler: (req: unknown, ctx: { log: unknown }) => unknown) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => ({}),
  rateLimit: (..._args: unknown[]) => ({ limited: false, retryAfter: 0 }),
}));

vi.mock('@/src/lib/auth/middleware', () => ({
  requireAuth: h.requireAuth,
}));

vi.mock('@/src/lib/auth/recovery-codes', () => ({
  generateRecoveryCodes: h.generateRecoveryCodes,
  RECOVERY_DISCLOSURE: 'disclosure-text',
}));

import { POST } from '../route';

function makeReq(body?: unknown): NextRequest {
  return { headers: new Headers(), json: async () => body } as unknown as NextRequest;
}

const DID = 'did:imajin:self-custody-user';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /auth/api/recovery-codes/generate', () => {
  it('requires authentication', async () => {
    h.requireAuth.mockResolvedValue(null);
    const res = await POST(makeReq({}));
    expect(res.status).toBe(401);
    expect(h.generateRecoveryCodes).not.toHaveBeenCalled();
  });

  it('rejects soft (custodial) identities', async () => {
    h.requireAuth.mockResolvedValue({ sub: DID, tier: 'soft' });
    const res = await POST(makeReq({}));
    expect(res.status).toBe(403);
    expect(h.generateRecoveryCodes).not.toHaveBeenCalled();
  });

  it('generates codes for a self-custody identity and returns them once with the disclosure', async () => {
    h.requireAuth.mockResolvedValue({ sub: DID, tier: 'preliminary' });
    h.generateRecoveryCodes.mockResolvedValue(['AAAA-BBBB', 'CCCC-DDDD']);

    const res = await POST(makeReq({}));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(h.generateRecoveryCodes).toHaveBeenCalledWith(DID, undefined);
    expect(body.codes).toEqual(['AAAA-BBBB', 'CCCC-DDDD']);
    expect(body.count).toBe(2);
    expect(body.disclosure).toBe('disclosure-text');
  });

  it('passes through a requested count', async () => {
    h.requireAuth.mockResolvedValue({ sub: DID, tier: 'established' });
    h.generateRecoveryCodes.mockResolvedValue(new Array(6).fill('X'));

    await POST(makeReq({ count: 6 }));

    expect(h.generateRecoveryCodes).toHaveBeenCalledWith(DID, 6);
  });
});
