/**
 * Tests for POST /auth/api/internal/verify-delegation (#1653).
 *
 * This endpoint is the whole authorization story behind `register_also`: the WS
 * server has no database of its own, so whatever this returns is what decides
 * whether one DID may read another's notification stream. The drizzle mock here
 * therefore evaluates the predicate the route builds against a fixture table
 * rather than returning a canned row — a revoked or non-agent membership has to
 * be excluded by the query itself, which is the only place that filtering lives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockSelect, mockWhere } = vi.hoisted(() => {
  const mockWhere = vi.fn();
  const mockSelect = vi.fn((_projection?: Record<string, unknown>) => ({
    from: () => ({ where: mockWhere }),
  }));
  return { mockSelect, mockWhere };
});

vi.mock('@/src/db', () => ({
  db: { select: mockSelect },
  identityMembers: {
    identityDid: 'identity_did',
    memberDid: 'member_did',
    role: 'role',
    removedAt: 'removed_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  isNull: (col: unknown) => ({ isNull: col }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { POST } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const INTERNAL_KEY = 'test-internal-key';
const AGENT = 'did:imajin:jin';
const PRINCIPAL = 'did:imajin:ryan';
const ENDPOINT = 'http://localhost:3000/auth/api/internal/verify-delegation';

type Row = Record<string, unknown>;
type Predicate =
  | { and: Predicate[] }
  | { eq: [string, unknown] }
  | { isNull: string };

/** The subset of drizzle predicates this route builds, applied to one row. */
function matches(row: Row, predicate: Predicate): boolean {
  if ('and' in predicate) return predicate.and.every((sub) => matches(row, sub));
  if ('eq' in predicate) return row[predicate.eq[0]] === predicate.eq[1];
  return row[predicate.isNull] == null;
}

/** An identity_members row: `memberDid` acts for `identityDid`. */
function membership(overrides: Row = {}): Row {
  return {
    identity_did: PRINCIPAL,
    member_did: AGENT,
    role: 'agent',
    removed_at: null,
    ...overrides,
  };
}

/** Rows the mocked `identity_members` table holds for the current test. */
let table: Row[] = [];

type RouteRequest = Parameters<typeof POST>[0];

function makeRequest(
  body: string,
  { key = INTERNAL_KEY as string | null } = {},
): RouteRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (key !== null) headers.set('x-internal-key', key);
  return new Request(ENDPOINT, { method: 'POST', headers, body }) as unknown as RouteRequest;
}

function verify(body: unknown, options?: { key?: string | null }) {
  return POST(makeRequest(JSON.stringify(body), options));
}

async function allowedFor(body: unknown): Promise<boolean> {
  const res = await verify(body);
  expect(res.status).toBe(200);
  return ((await res.json()) as { allowed: boolean }).allowed;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_INTERNAL_API_KEY = INTERNAL_KEY;
  table = [];
  mockWhere.mockImplementation((predicate: Predicate) => ({
    limit: (n: number) =>
      Promise.resolve(table.filter((row) => matches(row, predicate)).slice(0, n)),
  }));
});

afterEach(() => {
  delete process.env.AUTH_INTERNAL_API_KEY;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /auth/api/internal/verify-delegation — caller authentication', () => {
  it('rejects a request with no x-internal-key header', async () => {
    const res = await verify({ agentDid: AGENT, principalDid: PRINCIPAL }, { key: null });

    expect(res.status).toBe(401);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong key', async () => {
    const res = await verify({ agentDid: AGENT, principalDid: PRINCIPAL }, { key: 'nope' });

    expect(res.status).toBe(401);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('rejects every caller when AUTH_INTERNAL_API_KEY is unset', async () => {
    // Otherwise a missing key turns `header !== undefined` into an open endpoint
    // for anyone who omits the header.
    delete process.env.AUTH_INTERNAL_API_KEY;

    const res = await verify({ agentDid: AGENT, principalDid: PRINCIPAL }, { key: null });

    expect(res.status).toBe(401);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

describe('POST /auth/api/internal/verify-delegation — request body', () => {
  it('rejects a malformed JSON body', async () => {
    const res = await POST(makeRequest('{ not json'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON' });
  });

  it.each([
    ['missing agentDid', { principalDid: PRINCIPAL }],
    ['missing principalDid', { agentDid: AGENT }],
    ['empty agentDid', { agentDid: '', principalDid: PRINCIPAL }],
    ['non-string principalDid', { agentDid: AGENT, principalDid: 42 }],
    ['a null body', null],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await verify(body);

    expect(res.status).toBe(400);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

describe('POST /auth/api/internal/verify-delegation — delegation lookup', () => {
  it('allows an active agent membership', async () => {
    table = [membership()];

    expect(await allowedFor({ agentDid: AGENT, principalDid: PRINCIPAL })).toBe(true);
  });

  it('denies when no membership exists at all', async () => {
    expect(await allowedFor({ agentDid: AGENT, principalDid: PRINCIPAL })).toBe(false);
  });

  it('denies a revoked membership', async () => {
    table = [membership({ removed_at: new Date('2026-01-01T00:00:00.000Z') })];

    expect(await allowedFor({ agentDid: AGENT, principalDid: PRINCIPAL })).toBe(false);
  });

  it.each(['member', 'owner', 'admin', 'maintainer'])(
    'denies a role=%s membership — only agents may act for an identity',
    async (role) => {
      table = [membership({ role })];

      expect(await allowedFor({ agentDid: AGENT, principalDid: PRINCIPAL })).toBe(false);
    },
  );

  it('denies when the delegation points the other way round', async () => {
    // Ryan being an agent of Jin does not let Jin read Ryan's stream.
    table = [membership({ identity_did: AGENT, member_did: PRINCIPAL })];

    expect(await allowedFor({ agentDid: AGENT, principalDid: PRINCIPAL })).toBe(false);
  });

  it('denies a membership on a different principal', async () => {
    table = [membership({ identity_did: 'did:imajin:someone-else' })];

    expect(await allowedFor({ agentDid: AGENT, principalDid: PRINCIPAL })).toBe(false);
  });

  it('projects a column that exists — identity_members has no surrogate key', async () => {
    // Selecting `identityMembers.id` compiles to `undefined` and never reaches
    // the database as a column, so pin the projection to a real one.
    table = [membership()];

    await verify({ agentDid: AGENT, principalDid: PRINCIPAL });

    expect(mockSelect.mock.calls[0][0]).toEqual({ memberDid: 'member_did' });
  });

  it('denies rather than throwing when the lookup fails', async () => {
    mockWhere.mockImplementation(() => ({
      limit: () => Promise.reject(new Error('connection terminated')),
    }));

    const res = await verify({ agentDid: AGENT, principalDid: PRINCIPAL });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ allowed: false });
  });
});
