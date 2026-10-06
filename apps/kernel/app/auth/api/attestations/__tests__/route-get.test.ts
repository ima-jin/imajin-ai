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
  // Hybrid: chainable via `.orderBy()` (the main attestations query) AND
  // directly awaitable, resolving to `[]` (filterVisibleRows's registry-gated
  // types lookup, which awaits `.where(...)` with no further chaining).
  const whereMock = vi.fn(() => Object.assign(Promise.resolve([]), { orderBy: orderByMock }));
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  return { limitMock, orderByMock, whereMock, fromMock, selectMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  identities: {},
  registryApps: {},
  attestations: {
    subjectDid: 'attestations.subjectDid',
    revokedAt: 'attestations.revokedAt',
    type: 'attestations.type',
    issuerDid: 'attestations.issuerDid',
    contextId: 'attestations.contextId',
    attestationStatus: 'attestations.attestationStatus',
    issuedAt: 'attestations.issuedAt',
  },
  attestationTypeRegistry: { typeName: 'attestationTypeRegistry.typeName', revokedAt: 'attestationTypeRegistry.revokedAt' },
  tokens: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]): Op => ({ op: 'eq', args }),
  and: (...args: unknown[]): Op => ({ op: 'and', args }),
  isNull: (...args: unknown[]): Op => ({ op: 'isNull', args }),
  ne: (...args: unknown[]): Op => ({ op: 'ne', args }),
  gt: (...args: unknown[]): Op => ({ op: 'gt', args }),
  desc: (...args: unknown[]): Op => ({ op: 'desc', args }),
  notInArray: (...args: unknown[]): Op => ({ op: 'notInArray', args }),
  inArray: (...args: unknown[]): Op => ({ op: 'inArray', args }),
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
  evidenceGradeForAttestationStatus: vi.fn(),
  isDisclosureScope: (v: string) => ['parties', 'connections', 'network', 'public'].includes(v),
}));

vi.mock('@imajin/cid', () => ({ computeCid: vi.fn() }));

vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: unknown) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
  // The route module transitively imports grants.ts (via attestation-helpers'
  // delegation check, #1895/#1897), which calls createLogger at module scope.
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
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

function hasNe(args: unknown[]): boolean {
  return args.some((arg) => (arg as Op).op === 'ne');
}

/** The `eq(column, value)` conditions in the where-list, as `[column, value]` pairs. */
function eqPairs(args: unknown[]): unknown[][] {
  return args.filter((arg) => (arg as Op).op === 'eq').map((arg) => (arg as Op).args);
}

function hasEq(args: unknown[], column: string, value: string): boolean {
  return eqPairs(args).some(([col, val]) => col === column && val === value);
}

function hasEqOnColumn(args: unknown[], column: string): boolean {
  return eqPairs(args).some(([col]) => col === column);
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

// #2396 — optional exact-match `context_id` filter (indexed column).
describe('GET /auth/api/attestations — context_id filter (#2396)', () => {
  const base = 'https://kernel.test/auth/api/attestations?subject_did=did:imajin:bob';

  it('filters on attestations.contextId when context_id is provided', async () => {
    await GET(makeGetReq(`${base}&context_id=asset_survey_1`));

    const args = whereArgs();
    expect(hasEq(args, 'attestations.contextId', 'asset_survey_1')).toBe(true);
    expect(hasEq(args, 'attestations.subjectDid', 'did:imajin:bob')).toBe(true);
  });

  it('adds no context filter when context_id is omitted (backward compatible)', async () => {
    await GET(makeGetReq(base));

    const args = whereArgs();
    expect(hasEqOnColumn(args, 'attestations.contextId')).toBe(false);
    expect(hasEq(args, 'attestations.subjectDid', 'did:imajin:bob')).toBe(true);
  });

  it('adds no context filter when context_id is empty', async () => {
    await GET(makeGetReq(`${base}&context_id=`));

    expect(hasEqOnColumn(whereArgs(), 'attestations.contextId')).toBe(false);
  });

  it('combines context_id with type, issuer_did and status filters (all ANDed)', async () => {
    await GET(
      makeGetReq(
        `${base}&type=vouch&issuer_did=did:imajin:alice&status=bilateral&context_id=asset_survey_1`,
      ),
    );

    const args = whereArgs();
    expect(hasEq(args, 'attestations.subjectDid', 'did:imajin:bob')).toBe(true);
    expect(hasEq(args, 'attestations.type', 'vouch')).toBe(true);
    expect(hasEq(args, 'attestations.issuerDid', 'did:imajin:alice')).toBe(true);
    expect(hasEq(args, 'attestations.attestationStatus', 'bilateral')).toBe(true);
    expect(hasEq(args, 'attestations.contextId', 'asset_survey_1')).toBe(true);
  });

  it('still applies the default superseded exclusion alongside context_id', async () => {
    await GET(makeGetReq(`${base}&context_id=asset_survey_1`));

    expect(hasNe(whereArgs())).toBe(true);
  });

  it('returns the rows the query yields for the context', async () => {
    mocks.limitMock.mockResolvedValue([
      { id: 'att_ctx', type: 'vouch', issuerDid: 'did:imajin:alice', subjectDid: 'did:imajin:bob', contextId: 'asset_survey_1' },
    ]);

    const res = await GET(makeGetReq(`${base}&context_id=asset_survey_1`));

    expect(await res.json()).toEqual([expect.objectContaining({ id: 'att_ctx', contextId: 'asset_survey_1' })]);
  });
});

// #1790 — reads default to operative records (exclude superseded); an
// explicit status filter (including `status=superseded`, the history-ish
// query) is never overridden by the default exclusion.
describe('GET /auth/api/attestations — operative-vs-history reads (#1790)', () => {
  it('excludes superseded attestations by default (no status/evidence_grade filter)', async () => {
    await GET(makeGetReq('https://kernel.test/auth/api/attestations?subject_did=did:imajin:bob'));

    expect(hasNe(whereArgs())).toBe(true);
  });

  // #2394 acceptance: consumers must be able to distinguish a delegated
  // attestation (issuer acted for a delegator) from a self-signed one.
  it('includes delegatorDid on every returned row, unmodified (#2394)', async () => {
    mocks.limitMock.mockResolvedValue([
      { id: 'att_delegated', type: 'vouch', issuerDid: 'did:imajin:app-dykil', subjectDid: 'did:imajin:bob', delegatorDid: 'did:imajin:bob' },
      { id: 'att_self_signed', type: 'vouch', issuerDid: 'did:imajin:bob', subjectDid: 'did:imajin:bob', delegatorDid: null },
    ]);

    const res = await GET(makeGetReq('https://kernel.test/auth/api/attestations?subject_did=did:imajin:bob'));
    const body = await res.json();

    expect(body).toEqual([
      expect.objectContaining({ id: 'att_delegated', delegatorDid: 'did:imajin:bob' }),
      expect.objectContaining({ id: 'att_self_signed', delegatorDid: null }),
    ]);
  });

  it('does not add the default exclusion when an explicit status filter is given', async () => {
    await GET(makeGetReq('https://kernel.test/auth/api/attestations?subject_did=did:imajin:bob&status=superseded'));

    expect(hasNe(whereArgs())).toBe(false);
  });

  it('does not add the default exclusion when an explicit evidence_grade filter is given', async () => {
    await GET(
      makeGetReq('https://kernel.test/auth/api/attestations?subject_did=did:imajin:bob&evidence_grade=corroborated'),
    );

    expect(hasNe(whereArgs())).toBe(false);
  });
});
