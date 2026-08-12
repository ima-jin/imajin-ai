/**
 * Tests for GET /auth/api/attestations — the countersign-pending query
 * filter (#1822).
 *
 * An untyped `status=pending` query is the "pending your countersignature"
 * view: it must exclude mechanical audit-record types (session.created)
 * that were never awaiting anyone's signature. A caller that explicitly asks
 * for a mechanical type by name should still get it back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

interface Op {
  op: string;
  args: unknown[];
}

const mocks = vi.hoisted(() => {
  const limitMock = vi.fn();
  const orderByMock = vi.fn(() => ({ limit: limitMock }));
  const whereMock = vi.fn(() => ({ orderBy: orderByMock }));
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  return { limitMock, orderByMock, whereMock, fromMock, selectMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  identities: {},
  attestations: {
    subjectDid: 'attestations.subjectDid',
    revokedAt: 'attestations.revokedAt',
    type: 'attestations.type',
    issuerDid: 'attestations.issuerDid',
    attestationStatus: 'attestations.attestationStatus',
    issuedAt: 'attestations.issuedAt',
  },
  tokens: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]): Op => ({ op: 'eq', args }),
  and: (...args: unknown[]): Op => ({ op: 'and', args }),
  isNull: (...args: unknown[]): Op => ({ op: 'isNull', args }),
  gt: (...args: unknown[]): Op => ({ op: 'gt', args }),
  desc: (...args: unknown[]): Op => ({ op: 'desc', args }),
  notInArray: (...args: unknown[]): Op => ({ op: 'notInArray', args }),
}));

vi.mock('@/src/lib/auth/jwt', () => ({
  verifySessionToken: vi.fn(),
  getSessionCookieOptions: () => ({ name: 'session' }),
}));

vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));

vi.mock('@imajin/auth', () => ({
  canonicalize: (obj: unknown) => JSON.stringify(obj),
  crypto: { verifySync: () => true },
  ATTESTATION_TYPES: ['session.created', 'vouch'],
  MECHANICAL_ATTESTATION_TYPES: ['session.created'],
  verifyNostrSig: vi.fn(),
}));

vi.mock('@imajin/cid', () => ({ computeCid: vi.fn() }));

vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: unknown) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));

import { GET } from '../route';

function makeGetReq(url: string): NextRequest {
  return {
    url,
    cookies: { get: () => undefined },
    headers: new Headers(),
  } as unknown as NextRequest;
}

/** The top-level `and(...)` condition list passed to `.where()`. */
function whereArgs(): unknown[] {
  return (mocks.whereMock.mock.calls[0][0] as Op).args;
}

function hasNotInArray(args: unknown[]): boolean {
  return args.some((arg) => (arg as Op).op === 'notInArray');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limitMock.mockResolvedValue([]);
});

describe('GET /auth/api/attestations — countersign-pending filter (#1822)', () => {
  it('excludes mechanical attestation types when status=pending and no type filter is given', async () => {
    await GET(makeGetReq('https://kernel.test/auth/api/attestations?subject_did=did:imajin:bob&status=pending'));

    expect(hasNotInArray(whereArgs())).toBe(true);
  });

  it('does not exclude mechanical types when an explicit type filter is given', async () => {
    await GET(
      makeGetReq(
        'https://kernel.test/auth/api/attestations?subject_did=did:imajin:bob&status=pending&type=session.created',
      ),
    );

    expect(hasNotInArray(whereArgs())).toBe(false);
  });

  it('does not exclude mechanical types when status is not "pending"', async () => {
    await GET(makeGetReq('https://kernel.test/auth/api/attestations?subject_did=did:imajin:bob&status=bilateral'));

    expect(hasNotInArray(whereArgs())).toBe(false);
  });

  it('does not exclude mechanical types when no status filter is given', async () => {
    await GET(makeGetReq('https://kernel.test/auth/api/attestations?subject_did=did:imajin:bob'));

    expect(hasNotInArray(whereArgs())).toBe(false);
  });
});
