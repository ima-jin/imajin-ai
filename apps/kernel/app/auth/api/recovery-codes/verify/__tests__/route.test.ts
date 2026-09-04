import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  redeemRecoveryCode: vi.fn(),
  logRecoveryAttempt: vi.fn(async () => undefined),
  verifySignature: vi.fn(),
  challengesStore: new Map<string, Row>(),
  CHALLENGES_TABLE: { __table: 'challenges', id: 'id', identityId: 'identityId', usedAt: 'usedAt', expiresAt: 'expiresAt' },
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

vi.mock('@/src/lib/auth/crypto', () => ({
  verifySignature: h.verifySignature,
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (column: string, value: unknown) => (row: Row) => row[column] === value,
    and: (...preds: Array<(row: Row) => boolean>) => (row: Row) => preds.every((p) => p(row)),
    isNull: (column: string) => (row: Row) => row[column] == null,
    gt: (column: string, value: unknown) => (row: Row) => (row[column] as Date) > (value as Date),
  };
});

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (predicate: (row: Row) => boolean) => ({
          limit: (n: number) => Promise.resolve([...h.challengesStore.values()].filter(predicate).slice(0, n)),
        }),
      }),
    }),
    update: () => ({
      set: (patch: Row) => ({
        where: (predicate: (row: Row) => boolean) => {
          for (const [key, row] of h.challengesStore) {
            if (predicate(row)) h.challengesStore.set(key, { ...row, ...patch });
          }
          return Promise.resolve([]);
        },
      }),
    }),
  },
  challenges: h.CHALLENGES_TABLE,
}));

import { POST, OPTIONS } from '../route';

function makeReq(body?: unknown): NextRequest {
  return { headers: new Headers(), json: async () => body } as unknown as NextRequest;
}

function seedChallenge(did: string, overrides: Partial<Row> = {}) {
  const id = (overrides.id as string) ?? `rchl_${did}`;
  h.challengesStore.set(id, {
    identityId: did,
    challenge: 'the-challenge-hex',
    usedAt: null,
    expiresAt: new Date(Date.now() + 5 * 60_000),
    ...overrides,
    id,
  });
  return id;
}

const VALID_KEY = 'a'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  h.challengesStore.clear();
  h.verifySignature.mockResolvedValue(true);
});

describe('POST /auth/api/recovery-codes/verify', () => {
  it('requires did, code, newPublicKey, challengeId, and proofOfNewKey', async () => {
    const res = await POST(makeReq({ did: 'did:imajin:x' }));
    expect(res.status).toBe(400);
    expect(h.redeemRecoveryCode).not.toHaveBeenCalled();
  });

  it('returns a rotated response on success', async () => {
    const did = 'did:imajin:happy-path';
    const challengeId = seedChallenge(did);
    h.redeemRecoveryCode.mockResolvedValue({
      ok: true,
      sessionsInvalidated: true,
      chainDeprecated: false,
      disclosure: 'not trustless',
    });

    const res = await POST(makeReq({ did, code: 'ABCD-1234', newPublicKey: VALID_KEY, challengeId, proofOfNewKey: 'sig'.repeat(32) }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ did, rotated: true, sessionsInvalidated: true, chainDeprecated: false });
    expect(h.verifySignature).toHaveBeenCalledWith('the-challenge-hex', 'sig'.repeat(32), VALID_KEY);
  });

  it('returns a generic 401 when the challenge is missing, expired, or for a different DID', async () => {
    const res = await POST(makeReq({
      did: 'did:imajin:no-challenge', code: 'ZZZZ-0000', newPublicKey: VALID_KEY,
      challengeId: 'rchl_nonexistent', proofOfNewKey: 'sig'.repeat(32),
    }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe('Invalid recovery code');
    expect(h.redeemRecoveryCode).not.toHaveBeenCalled();
    expect(h.logRecoveryAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'invalid_challenge' }),
    );
  });

  it('returns a generic 401 when the proof-of-new-key signature does not verify', async () => {
    const did = 'did:imajin:bad-proof';
    const challengeId = seedChallenge(did);
    h.verifySignature.mockResolvedValue(false);

    const res = await POST(makeReq({ did, code: 'ZZZZ-0000', newPublicKey: VALID_KEY, challengeId, proofOfNewKey: 'sig'.repeat(32) }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe('Invalid recovery code');
    expect(h.redeemRecoveryCode).not.toHaveBeenCalled();
    expect(h.logRecoveryAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'invalid_proof' }),
    );
  });

  it('returns a generic 401 for an invalid code without leaking the specific reason', async () => {
    const did = 'did:imajin:wrong-code';
    const challengeId = seedChallenge(did);
    h.redeemRecoveryCode.mockResolvedValue({ ok: false, reason: 'invalid_code' });

    const res = await POST(makeReq({ did, code: 'ZZZZ-0000', newPublicKey: VALID_KEY, challengeId, proofOfNewKey: 'sig'.repeat(32) }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe('Invalid recovery code');
  });

  it('returns the same generic 401 for an unknown DID (no DID-existence oracle)', async () => {
    const did = 'did:imajin:nobody';
    const challengeId = seedChallenge(did);
    h.redeemRecoveryCode.mockResolvedValue({ ok: false, reason: 'identity_not_found' });

    const res = await POST(makeReq({ did, code: 'ZZZZ-0000', newPublicKey: VALID_KEY, challengeId, proofOfNewKey: 'sig'.repeat(32) }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe('Invalid recovery code');
  });

  it('returns 400 for a malformed public key', async () => {
    const did = 'did:imajin:bad-key';
    const challengeId = seedChallenge(did);
    h.redeemRecoveryCode.mockResolvedValue({ ok: false, reason: 'invalid_public_key' });

    const res = await POST(makeReq({ did, code: 'ZZZZ-0000', newPublicKey: 'not-hex', challengeId, proofOfNewKey: 'sig'.repeat(32) }));
    expect(res.status).toBe(400);
  });

  it('trips per-DID rate limiting after repeated attempts and audits the trip', async () => {
    h.redeemRecoveryCode.mockResolvedValue({ ok: false, reason: 'invalid_code' });
    const did = 'did:imajin:rate-limited-target';
    const challengeId = seedChallenge(did);

    let lastRes;
    for (let i = 0; i < 6; i++) {
      lastRes = await POST(makeReq({ did, code: 'ZZZZ-0000', newPublicKey: VALID_KEY, challengeId, proofOfNewKey: 'sig'.repeat(32) }));
    }

    expect(lastRes!.status).toBe(429);
    expect(h.logRecoveryAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ did, outcome: 'rate_limited' }),
    );
  });

  it('returns a 500 when redemption throws unexpectedly', async () => {
    const did = 'did:imajin:boom';
    const challengeId = seedChallenge(did);
    h.redeemRecoveryCode.mockRejectedValue(new Error('db unavailable'));

    const res = await POST(makeReq({ did, code: 'ZZZZ-0000', newPublicKey: VALID_KEY, challengeId, proofOfNewKey: 'sig'.repeat(32) }));
    expect(res.status).toBe(500);
  });
});

describe('OPTIONS /auth/api/recovery-codes/verify', () => {
  it('responds with 204 for CORS preflight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });
});
