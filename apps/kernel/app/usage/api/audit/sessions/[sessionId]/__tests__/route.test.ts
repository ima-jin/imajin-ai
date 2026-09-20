/**
 * GET /usage/api/audit/sessions/{sessionId} tests (#2204 auditor chain view).
 *
 * Covers: owner access, stranger 403, auditor-grant access via
 * `introspectGrant`, 404 for an unknown session, and that the returned
 * chain is ordered oldest-first and grouped by turn with each usage row's
 * transaction/attestation inlined.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockDbSelect, resetDbQueue, requireAuthMock, resolveActingDidMock, introspectGrantMock } = vi.hoisted(() => {
  let callIndex = 0;
  let queuedResults: unknown[][] = [];

  // The first call (usage.incurred rows) chains `.orderBy(...)`; the other
  // two (transactions, attestations) resolve directly — mirroring the
  // route's own query shapes. Named (rather than inlined) so the mock
  // factory below stays a flat sequence of calls, not nested arrows.
  function whereResult(idx: number): { orderBy: () => Promise<unknown[]> } | Promise<unknown[]> {
    if (idx === 0) {
      return { orderBy: () => Promise.resolve(queuedResults[0] ?? []) };
    }
    return Promise.resolve(queuedResults[idx] ?? []);
  }

  function fromResult(idx: number): { where: () => ReturnType<typeof whereResult> } {
    return { where: () => whereResult(idx) };
  }

  const mockDbSelect = vi.fn(() => {
    const idx = callIndex;
    callIndex += 1;
    return { from: () => fromResult(idx) };
  });

  function resetDbQueue(results: unknown[][]): void {
    callIndex = 0;
    queuedResults = results;
  }

  function resolveActingDid(identity: { actingFor?: string; actingAs?: string; id: string }): string {
    return identity.actingFor ?? identity.actingAs ?? identity.id;
  }

  const requireAuthMock = vi.fn();
  const resolveActingDidMock = vi.fn(resolveActingDid);
  const introspectGrantMock = vi.fn();

  return { mockDbSelect, resetDbQueue, requireAuthMock, resolveActingDidMock, introspectGrantMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mockDbSelect },
  usageIncurred: { sessionId: 'session_id', createdAt: 'created_at' },
  transactions: { id: 'id' },
  attestations: { type: 'type', contextType: 'context_type', contextId: 'context_id' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  asc: (col: unknown) => ({ asc: col }),
  inArray: (...args: unknown[]) => ({ inArray: args }),
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://example.test' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  resolveActingDid: resolveActingDidMock,
}));

vi.mock('@/src/lib/auth/grants', () => ({ introspectGrant: introspectGrantMock }));

import { GET, OPTIONS } from '../route';

const OWNER_DID = 'did:imajin:owner';
const AUDITOR_DID = 'did:imajin:auditor';
const STRANGER_DID = 'did:imajin:stranger';
const SESSION_ID = 'sess_1';

function makeReq(url = `https://kernel.test/usage/api/audit/sessions/${encodeURIComponent(SESSION_ID)}`): NextRequest {
  return new NextRequest(url);
}

function makeParams(sessionId: string = SESSION_ID) {
  return { params: Promise.resolve({ sessionId: encodeURIComponent(sessionId) }) };
}

function usageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'usage_1',
    sessionId: SESSION_ID,
    turnId: 'turn_1',
    principalDid: OWNER_DID,
    agentDid: null,
    source: 'inference-passthrough',
    resource: 'model:xai/grok-4',
    provider: 'xai',
    connectorId: 'conn_1',
    model: 'grok-4',
    tokensIn: 10,
    tokensOut: 5,
    costUsd: '0.00010000',
    quantity: '15.000000',
    unit: 'tokens',
    transactionId: 'tx_1',
    externalId: 'ext_1',
    status: null,
    createdAt: new Date('2026-09-20T10:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDbQueue([]);
  requireAuthMock.mockResolvedValue({ identity: { id: OWNER_DID } });
  introspectGrantMock.mockResolvedValue({ authorized: false });
});

describe('auth', () => {
  it('401s when the caller is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await GET(makeReq(), makeParams());

    expect(res.status).toBe(401);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('404s when no usage.incurred rows exist for the session', async () => {
    resetDbQueue([[]]);
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER_DID } });

    const res = await GET(makeReq(), makeParams());

    expect(res.status).toBe(404);
  });

  it('allows the session owner', async () => {
    resetDbQueue([[usageRow()], [], []]);
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER_DID } });

    const res = await GET(makeReq(), makeParams());

    expect(res.status).toBe(200);
    expect(introspectGrantMock).not.toHaveBeenCalled();
  });

  it('403s a stranger with no delegation grant', async () => {
    resetDbQueue([[usageRow()]]);
    requireAuthMock.mockResolvedValue({ identity: { id: STRANGER_DID } });
    introspectGrantMock.mockResolvedValue({ authorized: false, reason: 'No active grant' });

    const res = await GET(makeReq(), makeParams());

    expect(res.status).toBe(403);
    expect(introspectGrantMock).toHaveBeenCalledWith({
      agentDid: STRANGER_DID,
      capability: 'usage:read',
      delegatorDid: OWNER_DID,
      targetDid: OWNER_DID,
    });
  });

  it('allows an auditor holding an active usage:read grant from the owner', async () => {
    resetDbQueue([[usageRow()], [], []]);
    requireAuthMock.mockResolvedValue({ identity: { id: AUDITOR_DID } });
    introspectGrantMock.mockResolvedValue({ authorized: true, grantId: 'grant_1', delegatorDid: OWNER_DID });

    const res = await GET(makeReq(), makeParams());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.principalDid).toBe(OWNER_DID);
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });
});

describe('chain assembly + ordering', () => {
  it('groups usage rows by turn, oldest turn first, and inlines the linked transaction + attestation', async () => {
    const rowTurn1 = usageRow({
      id: 'usage_1',
      turnId: 'turn_1',
      transactionId: 'tx_1',
      externalId: 'ext_1',
      createdAt: new Date('2026-09-20T10:00:00.000Z'),
    });
    const rowTurn2 = usageRow({
      id: 'usage_2',
      turnId: 'turn_2',
      transactionId: null,
      externalId: 'ext_2',
      createdAt: new Date('2026-09-20T10:05:00.000Z'),
    });
    const tx1 = { id: 'tx_1', amount: '0.00010000', currency: 'USD', status: 'completed', toDid: 'did:imajin:xai-connector', createdAt: new Date('2026-09-20T10:00:01.000Z') };
    const attestation1 = {
      id: 'att_1',
      issuerDid: 'did:imajin:node',
      contextId: 'usage_1',
      signature: 'sig-1',
      cid: 'bafy-1',
      issuedAt: new Date('2026-09-20T10:00:02.000Z'),
      payload: { usageId: 'usage_1', sessionId: SESSION_ID, turnId: 'turn_1', externalId: 'ext_1' },
    };
    const attestation2 = {
      id: 'att_2',
      issuerDid: 'did:imajin:node',
      contextId: 'usage_2',
      signature: 'sig-2',
      cid: null,
      issuedAt: new Date('2026-09-20T10:05:02.000Z'),
      payload: { usageId: 'usage_2', sessionId: SESSION_ID, turnId: 'turn_2', externalId: 'ext_2' },
    };

    resetDbQueue([[rowTurn1, rowTurn2], [tx1], [attestation1, attestation2]]);
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER_DID } });

    const res = await GET(makeReq(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sessionId).toBe(SESSION_ID);
    expect(body.turns).toHaveLength(2);

    expect(body.turns[0].turnId).toBe('turn_1');
    expect(body.turns[0].usage).toHaveLength(1);
    expect(body.turns[0].usage[0]).toMatchObject({
      id: 'usage_1',
      externalId: 'ext_1',
      transaction: { id: 'tx_1', amount: '0.00010000', currency: 'USD', status: 'completed', toDid: 'did:imajin:xai-connector' },
      attestation: { id: 'att_1', signature: 'sig-1', cid: 'bafy-1' },
    });

    expect(body.turns[1].turnId).toBe('turn_2');
    expect(body.turns[1].usage[0]).toMatchObject({
      id: 'usage_2',
      externalId: 'ext_2',
      transaction: null,
      attestation: { id: 'att_2', signature: 'sig-2' },
    });
  });

  it('groups multiple usage rows within the same turn together, in chronological order', async () => {
    const rowA = usageRow({ id: 'usage_a', turnId: 'turn_1', createdAt: new Date('2026-09-20T10:00:00.000Z') });
    const rowB = usageRow({ id: 'usage_b', turnId: 'turn_1', createdAt: new Date('2026-09-20T10:00:05.000Z') });

    resetDbQueue([[rowA, rowB], [], []]);
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER_DID } });

    const res = await GET(makeReq(), makeParams());
    const body = await res.json();

    expect(body.turns).toHaveLength(1);
    expect(body.turns[0].usage.map((u: { id: string }) => u.id)).toEqual(['usage_a', 'usage_b']);
  });

  it('returns 500 without leaking the underlying failure when the query throws', async () => {
    mockDbSelect.mockImplementationOnce(() => {
      throw new Error('db down');
    });
    requireAuthMock.mockResolvedValue({ identity: { id: OWNER_DID } });

    const res = await GET(makeReq(), makeParams());

    expect(res.status).toBe(500);
  });
});
