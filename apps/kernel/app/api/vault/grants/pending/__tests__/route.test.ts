/**
 * Tests for GET /api/vault/grants/pending (#1603).
 *
 * The owner agent polls this to learn what it must sign. Before #1603 it returned
 * only the field and key material, because every request was implicitly a node
 * self-grant. A static-secret credential (#1439) is granted to a connector app DID
 * instead, so the custody pair now travels with the request — otherwise the owner
 * agent signs a self-grant and the connector silently never gains access.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireAdmin, mockOrderBy, mockUpdateWhere } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(async () => true),
  mockOrderBy: vi.fn<() => Promise<Array<Record<string, unknown>>>>(),
  mockUpdateWhere: vi.fn(async () => []),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: mockOrderBy }) }) }),
    update: () => ({ set: () => ({ where: mockUpdateWhere }) }),
  },
  vaultGrantRequests: {
    status: 'status', expiresAt: 'expiresAt', createdAt: 'createdAt', field: 'field',
    requestId: 'requestId', keyId: 'keyId', nodeXPub: 'nodeXPub', ownerXPub: 'ownerXPub',
    wrappedFieldKey: 'wrappedFieldKey', wrappedFieldKeyNonce: 'wrappedFieldKeyNonce',
    subject: 'subject', grantedTo: 'grantedTo',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (...a: unknown[]) => ({ eq: a }),
  gt: (...a: unknown[]) => ({ gt: a }),
  lt: (...a: unknown[]) => ({ lt: a }),
  or: (...a: unknown[]) => ({ or: a }),
  isNull: (a: unknown) => ({ isNull: a }),
  isNotNull: (a: unknown) => ({ isNotNull: a }),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: mockRequireAdmin }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({ senderDid: NODE_DID }),
}));

import { GET } from '../route';

const NODE_DID = 'did:imajin:testnode';
const PRINCIPAL = 'did:imajin:veteze';
const CONNECTOR = 'did:imajin:warp-connector';

/** A queued request row as the node writes it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    field: `warp-agent-key:${PRINCIPAL}`,
    keyId: 'kid:test',
    nodeXPub: '9'.repeat(64),
    ownerXPub: 'f'.repeat(64),
    wrappedFieldKey: 'WRAPPED',
    wrappedFieldKeyNonce: 'NONCE',
    createdAt: new Date('2026-08-04T00:00:00.000Z'),
    expiresAt: null,
    subject: PRINCIPAL,
    grantedTo: CONNECTOR,
    ...overrides,
  };
}

async function fetchRequests(): Promise<Array<Record<string, unknown>>> {
  const response = await GET();
  const body = (await response.json()) as { requests: Array<Record<string, unknown>> };
  return body.requests;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(true);
  mockOrderBy.mockResolvedValue([row()]);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/vault/grants/pending', () => {
  it('returns 401 for a non-admin caller', async () => {
    mockRequireAdmin.mockResolvedValue(false);
    expect((await GET()).status).toBe(401);
  });

  it('tells the owner agent which custody pair to sign', async () => {
    const [request] = await fetchRequests();

    expect(request.subject).toBe(PRINCIPAL);
    expect(request.grantedTo).toBe(CONNECTOR);
  });

  it('still delivers the key material wrapped to the node', async () => {
    const [request] = await fetchRequests();

    // `grantedTo` authorizes; it does not redirect the wrap. The node decrypts on
    // the grantee's behalf, so it stays the ECDH recipient.
    expect(request.nodeXPub).toBe('9'.repeat(64));
    expect(request.wrappedFieldKey).toBe('WRAPPED');
  });

  it('reads a pre-#1603 row with no custody pair as a node self-grant', async () => {
    // Those rows could only have been written by the self-grant path, so the node
    // DID is exact rather than a guess — and it keeps an in-flight request from the
    // previous deploy fulfillable.
    mockOrderBy.mockResolvedValue([row({ subject: null, grantedTo: null })]);

    const [request] = await fetchRequests();

    expect(request.subject).toBe(NODE_DID);
    expect(request.grantedTo).toBe(NODE_DID);
  });

  it('serialises timestamps as ISO strings', async () => {
    const expiresAt = new Date('2026-09-01T00:00:00.000Z');
    mockOrderBy.mockResolvedValue([row({ expiresAt })]);

    const [request] = await fetchRequests();

    expect(request.createdAt).toBe('2026-08-04T00:00:00.000Z');
    expect(request.expiresAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('sweeps expired requests before answering', async () => {
    await GET();
    // The owner agent's poll is the only regular traffic here, so the sweep rides
    // along with it rather than needing its own schedule.
    expect(mockUpdateWhere).toHaveBeenCalled();
  });
});
