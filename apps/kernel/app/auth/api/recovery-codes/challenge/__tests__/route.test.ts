import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  identitiesStore: new Map<string, Row>(),
  insertedChallenges: [] as Row[],
  IDENTITIES_TABLE: { __table: 'identities', id: 'id', tier: 'tier' },
  selectShouldThrow: false,
}));

vi.mock('@imajin/logger', () => ({
  withLogger:
    (_service: string, handler: (req: unknown, ctx: { log: unknown }) => unknown) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@imajin/config')>();
  return { ...actual, corsHeaders: () => ({}), getClientIP: () => '198.51.100.9' };
});

vi.mock('@imajin/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@imajin/auth')>();
  return { ...actual, CHALLENGE_TTL: 5 * 60_000 };
});

vi.mock('@/src/lib/auth/crypto', () => ({
  generateChallenge: () => 'deterministic-challenge-hex',
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, eq: (column: string, value: unknown) => (row: Row) => row[column] === value };
});

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (predicate: (row: Row) => boolean) => ({
          limit: (n: number) => {
            if (h.selectShouldThrow) throw new Error('db unavailable');
            return Promise.resolve([...h.identitiesStore.values()].filter(predicate).slice(0, n));
          },
        }),
      }),
    }),
    insert: () => ({
      values: (data: Row) => {
        h.insertedChallenges.push(data);
        return Promise.resolve([]);
      },
    }),
  },
  identities: h.IDENTITIES_TABLE,
  challenges: { __table: 'challenges' },
}));

import { GET, OPTIONS } from '../route';

function makeReq(url: string): NextRequest {
  return { headers: new Headers(), url } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.identitiesStore.clear();
  h.insertedChallenges.length = 0;
  h.selectShouldThrow = false;
});

const URL_BASE = 'https://kernel.example.com/auth/api/recovery-codes/challenge';

describe('GET /auth/api/recovery-codes/challenge', () => {
  it('requires a did query param', async () => {
    const res = await GET(makeReq(URL_BASE));
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown DID', async () => {
    const res = await GET(makeReq(`${URL_BASE}?did=did:imajin:nobody`));
    expect(res.status).toBe(404);
  });

  it('rejects a soft (custodial) identity', async () => {
    h.identitiesStore.set('did:imajin:soft-user', { id: 'did:imajin:soft-user', tier: 'soft' });
    const res = await GET(makeReq(`${URL_BASE}?did=did:imajin:soft-user`));
    expect(res.status).toBe(403);
  });

  it('issues a challenge tied to the DID for a self-custody identity', async () => {
    h.identitiesStore.set('did:imajin:recoverable', { id: 'did:imajin:recoverable', tier: 'preliminary' });
    const res = await GET(makeReq(`${URL_BASE}?did=did:imajin:recoverable`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.challenge).toBe('deterministic-challenge-hex');
    expect(body.challengeId).toMatch(/^rchl_/);
    expect(h.insertedChallenges).toHaveLength(1);
    expect(h.insertedChallenges[0]).toMatchObject({ identityId: 'did:imajin:recoverable', challenge: 'deterministic-challenge-hex' });
  });

  it('trips rate limiting after repeated requests for the same DID', async () => {
    h.identitiesStore.set('did:imajin:hammered', { id: 'did:imajin:hammered', tier: 'preliminary' });

    let lastRes;
    for (let i = 0; i < 11; i++) {
      lastRes = await GET(makeReq(`${URL_BASE}?did=did:imajin:hammered`));
    }

    expect(lastRes!.status).toBe(429);
  });

  it('returns a 500 when the identity lookup throws', async () => {
    h.selectShouldThrow = true;
    const res = await GET(makeReq(`${URL_BASE}?did=did:imajin:boom`));
    expect(res.status).toBe(500);
  });
});

describe('OPTIONS /auth/api/recovery-codes/challenge', () => {
  it('responds with 204 for CORS preflight', async () => {
    const res = await OPTIONS(makeReq(URL_BASE));
    expect(res.status).toBe(204);
  });
});
