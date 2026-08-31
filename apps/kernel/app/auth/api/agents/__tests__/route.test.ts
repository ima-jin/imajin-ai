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
  mockSelectWhere,
  mockDbSelect,
  mockTxInsertValues,
  mockTransaction,
  mockRequireAuth,
  mockListGrantDetailsForDelegator,
  pushSelectResult,
  resetSelectQueue,
} = vi.hoisted(() => {
  let queue: unknown[][] = [];
  const pushSelectResult = (rows: unknown[]) => queue.push(rows);
  const resetSelectQueue = () => { queue = []; };

  function queryableResult(rows: unknown[]) {
    const p = Promise.resolve(rows);
    return {
      then: p.then.bind(p),
      catch: p.catch.bind(p),
      finally: p.finally.bind(p),
      limit: (n: number) => Promise.resolve(rows.slice(0, n)),
      orderBy: () => Promise.resolve(rows),
    };
  }

  const mockSelectWhere = vi.fn(() => queryableResult(queue.length > 0 ? queue.shift()! : []));
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
  const mockListGrantDetailsForDelegator = vi.fn().mockResolvedValue([]);

  return {
    mockSelectWhere,
    mockDbSelect,
    mockTxInsertValues,
    mockTransaction,
    mockRequireAuth,
    mockListGrantDetailsForDelegator,
    pushSelectResult,
    resetSelectQueue,
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
  attestations: {
    subjectDid: 'attestations.subjectDid',
    type: 'attestations.type',
    payload: 'attestations.payload',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
  inArray: (...args: unknown[]) => ({ inArray: args }),
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

vi.mock('@/src/lib/auth/grants', () => ({
  listGrantDetailsForDelegator: mockListGrantDetailsForDelegator,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// ─── Subject under test ──────────────────────────────────────────────────────

import { GET, POST } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PERSONAL_DID = 'did:imajin:ryan-personal';
const BUSINESS_DID = 'did:imajin:agrifortress';
const LOCAL_AGENT_DID = 'did:imajin:jin';
const EXTERNAL_AGENT_DID = 'did:imajin:boardy-agent';
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

function grantDetail(overrides: Record<string, unknown> = {}) {
  return {
    grantId: 'grant_1',
    agentDid: LOCAL_AGENT_DID,
    delegatorDid: PERSONAL_DID,
    audience: { type: 'all' },
    onBehalfOf: [],
    issuedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-09-01T00:00:00.000Z',
    status: 'active',
    revokedAt: null,
    lastUsedAt: null,
    capabilities: [{ capability: 'messages:write', status: 'active', revokedAt: null }],
    history: [{ event: 'issued', capability: null, actorDid: PERSONAL_DID, createdAt: '2026-08-01T00:00:00.000Z' }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSelectQueue();
  mockRequireAuth.mockResolvedValue({ identity: { id: PERSONAL_DID } });
  mockTxInsertValues.mockResolvedValue(undefined);
  mockListGrantDetailsForDelegator.mockResolvedValue([]);
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

describe('GET /auth/api/agents (#1717 acting-for scoping)', () => {
  it('lists agents owned by the acting-for DID, not the caller personal DID', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: PERSONAL_DID, actingFor: BUSINESS_DID } });

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(200);
    expect(JSON.stringify(mockSelectWhere.mock.calls)).toContain(BUSINESS_DID);
    expect(JSON.stringify(mockSelectWhere.mock.calls)).not.toContain(PERSONAL_DID);
    expect(mockListGrantDetailsForDelegator).toHaveBeenCalledWith(BUSINESS_DID);
  });

  it('returns an empty grants-view list when the caller owns no agents and holds no grants', async () => {
    const res = await GET(makeGetRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [] });
  });
});

describe('GET /auth/api/agents (#1887 grants-view: sibling topology)', () => {
  it('embeds grants on an owned (local) agent and marks it internal by default', async () => {
    pushSelectResult([
      { did: LOCAL_AGENT_DID, handle: 'jin', name: 'Jin', createdAt: null, tier: 'preliminary', role: 'owner' },
    ]);
    mockListGrantDetailsForDelegator.mockResolvedValue([grantDetail()]);
    // allAgentDids is non-empty (owned agent) -> attestations query + legacy membership query both run.
    pushSelectResult([]); // externalIdentityAttestations: none
    pushSelectResult([]); // legacyMembershipRows: none

    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({
      did: LOCAL_AGENT_DID,
      role: 'owner',
      isExternal: false,
      externalDid: null,
      hasLegacyMembership: false,
    });
    expect(body.agents[0].grants).toHaveLength(1);
    expect(body.agents[0].grants[0].grantId).toBe('grant_1');
  });

  it('surfaces an external agent that only exists via a grant, never via identity_members ownership', async () => {
    pushSelectResult([]); // ownedRows: caller owns nothing locally
    mockListGrantDetailsForDelegator.mockResolvedValue([grantDetail({ agentDid: EXTERNAL_AGENT_DID })]);
    pushSelectResult([
      { did: EXTERNAL_AGENT_DID, handle: null, name: 'Boardy', createdAt: null, tier: 'preliminary' },
    ]); // externalIdentityRows
    pushSelectResult([
      { subjectDid: EXTERNAL_AGENT_DID, payload: { external_did: 'did:web:boardy.ai' } },
    ]); // externalIdentityAttestations
    pushSelectResult([]); // legacyMembershipRows

    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({
      did: EXTERNAL_AGENT_DID,
      role: 'grant',
      isExternal: true,
      externalDid: 'did:web:boardy.ai',
    });
  });

  it('merges a local and an external agent into one list, distinguished by the external-identity attestation', async () => {
    pushSelectResult([
      { did: LOCAL_AGENT_DID, handle: 'jin', name: 'Jin', createdAt: null, tier: 'preliminary', role: 'owner' },
    ]);
    mockListGrantDetailsForDelegator.mockResolvedValue([
      grantDetail({ agentDid: LOCAL_AGENT_DID }),
      grantDetail({ grantId: 'grant_2', agentDid: EXTERNAL_AGENT_DID }),
    ]);
    pushSelectResult([
      { did: EXTERNAL_AGENT_DID, handle: null, name: 'Boardy', createdAt: null, tier: 'preliminary' },
    ]); // externalIdentityRows (only the non-owned agent)
    pushSelectResult([
      { subjectDid: EXTERNAL_AGENT_DID, payload: { external_did: 'did:web:boardy.ai' } },
    ]); // externalIdentityAttestations
    pushSelectResult([]); // legacyMembershipRows

    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(body.agents.map((a: { did: string }) => a.did).sort()).toEqual(
      [LOCAL_AGENT_DID, EXTERNAL_AGENT_DID].sort(),
    );
    const local = body.agents.find((a: { did: string }) => a.did === LOCAL_AGENT_DID);
    const external = body.agents.find((a: { did: string }) => a.did === EXTERNAL_AGENT_DID);
    expect(local.isExternal).toBe(false);
    expect(external.isExternal).toBe(true);
  });

  it('flags an agent that is still reachable only via the #1887 dual-read membership fallback', async () => {
    pushSelectResult([
      { did: LOCAL_AGENT_DID, handle: 'jin', name: 'Jin', createdAt: null, tier: 'preliminary', role: 'owner' },
    ]);
    mockListGrantDetailsForDelegator.mockResolvedValue([]); // no grant issued yet
    pushSelectResult([]); // externalIdentityAttestations
    pushSelectResult([{ memberDid: LOCAL_AGENT_DID }]); // legacyMembershipRows: still has role='agent' membership

    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(body.agents[0]).toMatchObject({ did: LOCAL_AGENT_DID, hasLegacyMembership: true, grants: [] });
  });

  it('includes revoked/expired grants on an agent — the record does not disappear because the authority did', async () => {
    pushSelectResult([
      { did: LOCAL_AGENT_DID, handle: 'jin', name: 'Jin', createdAt: null, tier: 'preliminary', role: 'owner' },
    ]);
    mockListGrantDetailsForDelegator.mockResolvedValue([
      grantDetail({ grantId: 'grant_revoked', status: 'revoked', revokedAt: '2026-08-15T00:00:00.000Z' }),
    ]);
    pushSelectResult([]);
    pushSelectResult([]);

    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(body.agents[0].grants).toHaveLength(1);
    expect(body.agents[0].grants[0]).toMatchObject({ grantId: 'grant_revoked', status: 'revoked' });
  });
});
