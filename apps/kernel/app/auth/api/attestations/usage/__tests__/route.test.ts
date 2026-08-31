/**
 * Tests for GET /auth/api/attestations/usage (#1863) — the turn-usage query
 * endpoint with computed token deltas and session rollups.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

interface Op {
  op: string;
  args: unknown[];
}

const mocks = vi.hoisted(() => {
  const rows: Record<string, unknown>[] = [];
  const orderByMock = vi.fn(() => Promise.resolve(rows));
  const whereMock = vi.fn(() => ({ orderBy: orderByMock }));
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  return { rows, orderByMock, whereMock, fromMock, selectMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  attestations: {
    id: 'attestations.id',
    issuedAt: 'attestations.issuedAt',
    payload: 'attestations.payload',
    subjectDid: 'attestations.subjectDid',
    revokedAt: 'attestations.revokedAt',
    type: 'attestations.type',
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

import { GET } from '../route';

const SUBJECT = 'did:imajin:ADEKFWc2pbTKzfgzA3q6yrc1rEPNeMEP71mkBbCan54k';

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
  mocks.orderByMock.mockImplementation(() => Promise.resolve(mocks.rows));
});

describe('GET /auth/api/attestations/usage (#1863)', () => {
  it('requires subject_did', async () => {
    const res = await GET(makeGetReq('https://kernel.test/auth/api/attestations/usage'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/subject_did/);
  });

  it('is callable without any auth header or cookie (matches GET /auth/api/attestations for this hardcoded type)', async () => {
    mocks.rows.push(dbRow({ id: 'att_1', issuedAt: '2026-08-18T22:55:00.000Z', session: 's1', total: 17800, costTotal: 0.24 }));

    const res = await GET(makeGetReq(`https://kernel.test/auth/api/attestations/usage?subject_did=${SUBJECT}`));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
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
