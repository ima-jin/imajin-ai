/**
 * Tests for GET /auth/api/attestations/usage (#1863 read contract; #1967
 * auth). #1967 closed an anonymous-read hole: the route now requires a
 * session and only serves the subject itself or an active identity_members
 * member of the subject — every other caller, including one naming a
 * subject_did that doesn't exist, gets an identical 403.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

interface Op {
  op: string;
  args: unknown[];
}

const mocks = vi.hoisted(() => {
  const rows: Record<string, unknown>[] = [];
  const membershipRows: Record<string, unknown>[] = [];
  const orderByMock = vi.fn(() => Promise.resolve(rows));
  const limitMock = vi.fn(() => Promise.resolve(membershipRows));
  const requireAuth = vi.fn();
  return { rows, membershipRows, orderByMock, limitMock, requireAuth };
});

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: mocks.orderByMock,
          limit: mocks.limitMock,
        }),
      }),
    }),
  },
  attestations: {
    id: 'attestations.id',
    issuedAt: 'attestations.issuedAt',
    payload: 'attestations.payload',
    subjectDid: 'attestations.subjectDid',
    revokedAt: 'attestations.revokedAt',
    type: 'attestations.type',
  },
  identityMembers: {
    identityDid: 'identity_members.identity_did',
    memberDid: 'identity_members.member_did',
    removedAt: 'identity_members.removed_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]): Op => ({ op: 'eq', args }),
  and: (...args: unknown[]): Op => ({ op: 'and', args }),
  isNull: (...args: unknown[]): Op => ({ op: 'isNull', args }),
  lt: (...args: unknown[]): Op => ({ op: 'lt', args }),
}));

vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));

vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: unknown) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
}));

vi.mock('@/src/lib/auth/middleware', () => ({ requireAuth: mocks.requireAuth }));

import { GET } from '../route';

const SUBJECT = 'did:imajin:ADEKFWc2pbTKzfgzA3q6yrc1rEPNeMEP71mkBbCan54k';
const MEMBER = 'did:imajin:owner-of-subject';
const STRANGER = 'did:imajin:mallory';

function makeGetReq(url: string): NextRequest {
  return {
    url,
    headers: new Headers(),
  } as unknown as NextRequest;
}

function dbRow(overrides: {
  id: string;
  issuedAt: string;
  session?: string;
  tokensIn?: number;
  tokensOut?: number;
  total?: number;
  costTotal?: number;
  channel?: string;
  model?: string;
}) {
  return {
    id: overrides.id,
    issuedAt: new Date(overrides.issuedAt),
    payload: {
      session: overrides.session,
      model: overrides.model ?? 'anthropic/claude-opus-4-6',
      tokens: { input: overrides.tokensIn ?? 0, output: overrides.tokensOut ?? 0, total: overrides.total },
      cost: { input: 0, output: 0, total: overrides.costTotal ?? 0 },
      channel: overrides.channel ?? 'telegram',
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows.length = 0;
  mocks.membershipRows.length = 0;
  mocks.orderByMock.mockImplementation(() => Promise.resolve(mocks.rows));
  mocks.limitMock.mockImplementation(() => Promise.resolve(mocks.membershipRows));
  // Default: an authenticated caller who is the subject itself — the
  // simplest passing case. Individual tests override as needed.
  mocks.requireAuth.mockResolvedValue({ sub: SUBJECT });
});

describe('GET /auth/api/attestations/usage — auth (#1967)', () => {
  it('returns 401 when there is no session', async () => {
    mocks.requireAuth.mockResolvedValue(null);

    const res = await GET(makeGetReq(`https://kernel.test/auth/api/attestations/usage?subject_did=${SUBJECT}`));

    expect(res.status).toBe(401);
  });

  it('allows the subject itself', async () => {
    mocks.requireAuth.mockResolvedValue({ sub: SUBJECT });
    mocks.rows.push(dbRow({ id: 'att_1', issuedAt: '2026-08-18T22:55:00.000Z', session: 's1' }));

    const res = await GET(makeGetReq(`https://kernel.test/auth/api/attestations/usage?subject_did=${SUBJECT}`));

    expect(res.status).toBe(200);
  });

  it('allows an active identity_members member of the subject', async () => {
    mocks.requireAuth.mockResolvedValue({ sub: MEMBER });
    mocks.membershipRows.push({ memberDid: MEMBER });
    mocks.rows.push(dbRow({ id: 'att_1', issuedAt: '2026-08-18T22:55:00.000Z', session: 's1' }));

    const res = await GET(makeGetReq(`https://kernel.test/auth/api/attestations/usage?subject_did=${SUBJECT}`));

    expect(res.status).toBe(200);
  });

  it('rejects a stranger with 403', async () => {
    mocks.requireAuth.mockResolvedValue({ sub: STRANGER });
    mocks.membershipRows.length = 0; // no active membership row

    const res = await GET(makeGetReq(`https://kernel.test/auth/api/attestations/usage?subject_did=${SUBJECT}`));

    expect(res.status).toBe(403);
  });

  it('returns the identical 403 body for a stranger and for a non-existent subject_did (no existence leak)', async () => {
    mocks.requireAuth.mockResolvedValue({ sub: STRANGER });
    mocks.membershipRows.length = 0;

    const strangerRes = await GET(makeGetReq(`https://kernel.test/auth/api/attestations/usage?subject_did=${SUBJECT}`));
    const strangerBody = await strangerRes.json();

    const missingRes = await GET(
      makeGetReq(`https://kernel.test/auth/api/attestations/usage?subject_did=did:imajin:does-not-exist`),
    );
    const missingBody = await missingRes.json();

    expect(strangerRes.status).toBe(403);
    expect(missingRes.status).toBe(403);
    expect(missingBody).toEqual(strangerBody);
  });

  it('does not query attestation rows at all when unauthorized', async () => {
    mocks.requireAuth.mockResolvedValue({ sub: STRANGER });
    mocks.membershipRows.length = 0;

    await GET(makeGetReq(`https://kernel.test/auth/api/attestations/usage?subject_did=${SUBJECT}`));

    expect(mocks.orderByMock).not.toHaveBeenCalled();
  });

  it('rejects a removed (former) member', async () => {
    // A removed member's row is excluded by the DB-level isNull(removedAt)
    // filter, so from this route's perspective it looks identical to "no
    // active membership row" — hence an empty membershipRows result here.
    mocks.requireAuth.mockResolvedValue({ sub: MEMBER });
    mocks.membershipRows.length = 0;

    const res = await GET(makeGetReq(`https://kernel.test/auth/api/attestations/usage?subject_did=${SUBJECT}`));

    expect(res.status).toBe(403);
  });
});

describe('GET /auth/api/attestations/usage (#1863) — read contract', () => {
  it('requires subject_did', async () => {
    const res = await GET(makeGetReq('https://kernel.test/auth/api/attestations/usage'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/subject_did/);
  });

  it('returns rows newest first with computed tokenDelta and session rollups', async () => {
    mocks.rows.push(
      dbRow({ id: 'att_older', issuedAt: '2026-08-18T22:00:00.000Z', session: 's1', tokensIn: 12000, tokensOut: 800, total: 12800, costTotal: 0.1 }),
      dbRow({ id: 'att_newer', issuedAt: '2026-08-18T22:05:00.000Z', session: 's1', tokensIn: 15000, tokensOut: 1000, total: 16300, costTotal: 0.14 }),
    );

    const res = await GET(makeGetReq(`https://kernel.test/auth/api/attestations/usage?subject_did=${SUBJECT}`));
    const body = await res.json();

    expect(body.map((r: { id: string }) => r.id)).toEqual(['att_newer', 'att_older']);
    expect(body[0].tokenDelta).toBe(16300 - 12800);
    expect(body[0].sessionTokensIn).toBe(12000 + 15000);
    expect(body[0].sessionTokensOut).toBe(800 + 1000);
    expect(body[0].sessionCostTotal).toBeCloseTo(0.24);
    expect(body[1].tokenDelta).toBe(0);
  });

  it('filters to the given session key', async () => {
    mocks.rows.push(
      dbRow({ id: 'att_s1', issuedAt: '2026-08-18T22:00:00.000Z', session: 's1' }),
      dbRow({ id: 'att_s2', issuedAt: '2026-08-18T22:01:00.000Z', session: 's2' }),
    );

    const res = await GET(
      makeGetReq(`https://kernel.test/auth/api/attestations/usage?subject_did=${SUBJECT}&session=s2`),
    );
    const body = await res.json();

    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('att_s2');
  });

  it('defaults limit to 50 and clamps an oversized limit to 200', async () => {
    for (let i = 0; i < 10; i++) {
      mocks.rows.push(dbRow({ id: `att_${i}`, issuedAt: `2026-08-18T22:0${i}:00.000Z`, session: 's1' }));
    }

    const defaultRes = await GET(makeGetReq(`https://kernel.test/auth/api/attestations/usage?subject_did=${SUBJECT}`));
    expect(await defaultRes.json()).toHaveLength(10); // fewer rows than the default cap of 50

    const clampedRes = await GET(
      makeGetReq(`https://kernel.test/auth/api/attestations/usage?subject_did=${SUBJECT}&limit=9999`),
    );
    expect((await clampedRes.json()).length).toBeLessThanOrEqual(200);
  });

  it('rejects an invalid before cursor', async () => {
    const res = await GET(
      makeGetReq(`https://kernel.test/auth/api/attestations/usage?subject_did=${SUBJECT}&before=not-a-date`),
    );

    expect(res.status).toBe(400);
  });

  it('returns 500 when the database query fails', async () => {
    mocks.orderByMock.mockImplementation(() => Promise.reject(new Error('db down')));

    const res = await GET(makeGetReq(`https://kernel.test/auth/api/attestations/usage?subject_did=${SUBJECT}`));

    expect(res.status).toBe(500);
  });
});
