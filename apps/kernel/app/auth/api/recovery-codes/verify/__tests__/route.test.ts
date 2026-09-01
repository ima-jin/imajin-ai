import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  redeemRecoveryCode: vi.fn(),
  logRecoveryAttempt: vi.fn(async () => undefined),
}));

vi.mock('@imajin/logger', () => ({
  withLogger:
    (_service: string, handler: (req: unknown, ctx: { log: unknown }) => unknown) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// Use the REAL rate limiter (in-memory, per-process) so the rate-limit-trip
// test below exercises actual limiting behaviour rather than a mock.
vi.mock('@imajin/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@imajin/config')>();
  return { ...actual, corsHeaders: () => ({}), getClientIP: () => '198.51.100.9' };
});

vi.mock('@/src/lib/auth/recovery-codes', () => ({
  redeemRecoveryCode: h.redeemRecoveryCode,
  logRecoveryAttempt: h.logRecoveryAttempt,
}));

import { POST } from '../route';

function makeReq(body?: unknown): NextRequest {
  return { headers: new Headers(), json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /auth/api/recovery-codes/verify', () => {
  it('requires did, code, and newPublicKey', async () => {
    const res = await POST(makeReq({ did: 'did:imajin:x' }));
    expect(res.status).toBe(400);
    expect(h.redeemRecoveryCode).not.toHaveBeenCalled();
  });

  it('returns a rotated response on success', async () => {
    h.redeemRecoveryCode.mockResolvedValue({
      ok: true,
      sessionsInvalidated: true,
      chainDeprecated: false,
      disclosure: 'not trustless',
    });

    const res = await POST(makeReq({ did: 'did:imajin:happy-path', code: 'ABCD-1234', newPublicKey: 'a'.repeat(64) }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ did: 'did:imajin:happy-path', rotated: true, sessionsInvalidated: true, chainDeprecated: false });
  });

  it('returns a generic 401 for an invalid code without leaking the specific reason', async () => {
    h.redeemRecoveryCode.mockResolvedValue({ ok: false, reason: 'invalid_code' });

    const res = await POST(makeReq({ did: 'did:imajin:wrong-code', code: 'ZZZZ-0000', newPublicKey: 'a'.repeat(64) }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe('Invalid recovery code');
  });

  it('returns the same generic 401 for an unknown DID (no DID-existence oracle)', async () => {
    h.redeemRecoveryCode.mockResolvedValue({ ok: false, reason: 'identity_not_found' });

    const res = await POST(makeReq({ did: 'did:imajin:nobody', code: 'ZZZZ-0000', newPublicKey: 'a'.repeat(64) }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe('Invalid recovery code');
  });

  it('returns 400 for a malformed public key', async () => {
    h.redeemRecoveryCode.mockResolvedValue({ ok: false, reason: 'invalid_public_key' });

    const res = await POST(makeReq({ did: 'did:imajin:bad-key', code: 'ZZZZ-0000', newPublicKey: 'not-hex' }));
    expect(res.status).toBe(400);
  });

  it('trips per-DID rate limiting after repeated attempts and audits the trip', async () => {
    h.redeemRecoveryCode.mockResolvedValue({ ok: false, reason: 'invalid_code' });
    const did = 'did:imajin:rate-limited-target';

    let lastRes;
    for (let i = 0; i < 6; i++) {
      lastRes = await POST(makeReq({ did, code: 'ZZZZ-0000', newPublicKey: 'a'.repeat(64) }));
    }

    expect(lastRes!.status).toBe(429);
    expect(h.logRecoveryAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ did, outcome: 'rate_limited' }),
    );
  });
});
