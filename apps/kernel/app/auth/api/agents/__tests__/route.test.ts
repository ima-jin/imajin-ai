import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────
// vi.mock factories are hoisted; all referenced variables must come from vi.hoisted.

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
}));

const {
  mockSelectLimit,
  mockSelectOrderBy,
  mockSelectWhere,
  mockDbSelect,
  mockTxInsertValues,
  mockTransaction,
  mockRequireAuth,
} = vi.hoisted(() => {
  const mockSelectLimit = vi.fn().mockResolvedValue([]);
  const mockSelectOrderBy = vi.fn().mockResolvedValue([]);
  const mockSelectWhere = vi.fn(() => ({ limit: mockSelectLimit, orderBy: mockSelectOrderBy }));
  const mockDbSelect = vi.fn(() => ({
    from: vi.fn(() => ({
      where: mockSelectWhere,
      innerJoin: vi.fn(() => ({ where: mockSelectWhere })),
    })),
  }));

  const mockTxInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
    const tx = { insert: vi.fn(() => ({ values: mockTxInsertValues })) };
    return fn(tx);
  });

  const mockRequireAuth = vi.fn();

  return {
    mockSelectLimit,
    mockSelectOrderBy,
    mockSelectWhere,
    mockDbSelect,
    mockTxInsertValues,
    mockTransaction,
    mockRequireAuth,
  };
});

vi.mock('@/src/db', () => ({
  db: {
    select: mockDbSelect,
    transaction: mockTransaction,
  },
  identities: {
    id: 'identities.id',
    handle: 'identities.handle',
    name: 'identities.name',
    createdAt: 'identities.createdAt',
    tier: 'identities.tier',
    subtype: 'identities.subtype',
    scope: 'identities.scope',
  },
  identityMembers: {
    identityDid: 'identityMembers.identityDid',
    memberDid: 'identityMembers.memberDid',
    role: 'identityMembers.role',
    removedAt: 'identityMembers.removedAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  // Mirrors the real precedence in packages/auth/src/acting-did.ts (#1717):
  // a route that regresses to reading `identity.id` directly instead of
  // threading the whole identity through `resolveActingDid` fails these tests.
  resolveActingDid: (identity: { id: string; actingFor?: string; actingAs?: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
  generateKeypair: () => ({ privateKey: 'priv-hex', publicKey: 'pub-hex' }),
}));

vi.mock('@/src/lib/auth/crypto', () => ({
  didFromPublicKey: (publicKey: string) => `did:imajin:${publicKey}`,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// ─── Subject under test ──────────────────────────────────────────────────────

import { GET, POST } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PERSONAL_DID = 'did:imajin:ryan-personal';
const BUSINESS_DID = 'did:imajin:agrifortress';
const BASE_URL = 'https://test.imajin.ai/auth/api/agents';

function makeGetRequest(): Request {
  return new Request(BASE_URL, { method: 'GET' });
}

function makePostRequest(body: Record<string, unknown>): Request {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: PERSONAL_DID } });
  mockSelectLimit.mockResolvedValue([]);
  mockSelectOrderBy.mockResolvedValue([]);
  mockTxInsertValues.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
    const tx = { insert: vi.fn(() => ({ values: mockTxInsertValues })) };
    return fn(tx);
  });
});

describe('POST /auth/api/agents (#1717)', () => {
  it('owns the new agent under the raw session DID when not acting for anyone', async () => {
    const res = await POST(makePostRequest({ handle: 'my-bot' }));

    expect(res.status).toBe(201);
    expect(mockTransaction).toHaveBeenCalledOnce();
    const ownerRow = mockTxInsertValues.mock.calls[1][0] as Record<string, unknown>;
    expect(ownerRow.memberDid).toBe(PERSONAL_DID);
    expect(ownerRow.addedBy).toBe(PERSONAL_DID);
    const reverseRow = mockTxInsertValues.mock.calls[2][0] as Record<string, unknown>;
    expect(reverseRow.identityDid).toBe(PERSONAL_DID);
  });

  it('owns the new agent under the acting-for DID, not the caller personal DID', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: PERSONAL_DID, actingFor: BUSINESS_DID } });

    const res = await POST(makePostRequest({ handle: 'business-bot' }));

    expect(res.status).toBe(201);
    const ownerRow = mockTxInsertValues.mock.calls[1][0] as Record<string, unknown>;
    expect(ownerRow.memberDid).toBe(BUSINESS_DID);
    expect(ownerRow.addedBy).toBe(BUSINESS_DID);
    const reverseRow = mockTxInsertValues.mock.calls[2][0] as Record<string, unknown>;
    expect(reverseRow.identityDid).toBe(BUSINESS_DID);
    expect(reverseRow.memberDid).toMatch(/^did:imajin:/);
  });

  it('reports a transaction failure instead of claiming a partial creation succeeded', async () => {
    mockTxInsertValues
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('membership insert failed'));
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = { insert: vi.fn(() => ({ values: mockTxInsertValues })) };
      return fn(tx);
    });

    const res = await POST(makePostRequest({ handle: 'flaky-bot' }));

    expect(res.status).toBe(500);
  });
});

describe('GET /auth/api/agents (#1717)', () => {
  it('lists agents owned by the acting-for DID, not the caller personal DID', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: PERSONAL_DID, actingFor: BUSINESS_DID } });

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(200);
    expect(JSON.stringify(mockSelectWhere.mock.calls)).toContain(BUSINESS_DID);
    expect(JSON.stringify(mockSelectWhere.mock.calls)).not.toContain(PERSONAL_DID);
  });
});
