/**
 * Unit tests for GET /api/vault/grants/renewable (#1535).
 *
 * The owner agent cannot renew what it cannot see. This endpoint is the
 * discovery half of the renewal path: it names the fields the node can no
 * longer read (or soon won't) and hands back the envelope needed to mint a
 * replacement grant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockListRenewableGrants, mockRequireAdmin } = vi.hoisted(() => ({
  mockListRenewableGrants: vi.fn<() => Promise<Array<Record<string, unknown>>>>(),
  mockRequireAdmin: vi.fn(async () => true),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: mockRequireAdmin }));

vi.mock('@/src/lib/vault', () => ({ listRenewableGrants: mockListRenewableGrants }));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({
    senderDid: NODE_DID,
    senderPubkey: 'a'.repeat(64),
    privateKeyHex: 'b'.repeat(64),
  }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));

import { GET } from '../route.js';

const NODE_DID = 'did:imajin:testnode';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function makeRequest(query = ''): Request {
  return new Request(`http://localhost/api/vault/grants/renewable${query}`);
}

function renewableRow() {
  return {
    field: 'GH_TOKEN',
    keyId: 'kid:test',
    reason: 'missing',
    expiresAt: null,
    ownerXPub: 'f'.repeat(64),
    senderXPub: '9'.repeat(64),
    wrappedKey: 'WRAPPED',
    wrappedNonce: 'NONCE',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(true);
  mockListRenewableGrants.mockResolvedValue([renewableRow()]);
});

describe('GET /api/vault/grants/renewable', () => {
  it('returns 401 when not an admin', async () => {
    mockRequireAdmin.mockResolvedValue(false);
    expect((await GET(makeRequest() as never)).status).toBe(401);
  });

  it('returns the worklist scoped to this node', async () => {
    const response = await GET(makeRequest() as never);
    const body = await response.json() as { nodeDid: string; grants: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.nodeDid).toBe(NODE_DID);
    expect(body.grants).toHaveLength(1);
    expect(mockListRenewableGrants).toHaveBeenCalledWith(
      expect.objectContaining({ nodeDid: NODE_DID }),
    );
  });

  it('includes the envelope material the owner needs to mint a grant', async () => {
    const response = await GET(makeRequest() as never);
    const body = await response.json() as { grants: Array<Record<string, unknown>> };

    // Listing the field without the envelope would tell the owner what is broken
    // and give them no way to fix it. Only ownerXPriv opens this, so returning it
    // is no wider than /grants/pending already is.
    expect(body.grants[0]).toMatchObject({
      wrappedKey: 'WRAPPED',
      wrappedNonce: 'NONCE',
      senderXPub: '9'.repeat(64),
    });
  });

  it('defaults to a seven-day lookahead', async () => {
    await GET(makeRequest() as never);

    expect(mockListRenewableGrants).toHaveBeenCalledWith(
      expect.objectContaining({ withinMs: 7 * MS_PER_DAY }),
    );
  });

  it('honours an explicit withinDays', async () => {
    const response = await GET(makeRequest('?withinDays=30') as never);
    const body = await response.json() as { withinDays: number };

    expect(body.withinDays).toBe(30);
    expect(mockListRenewableGrants).toHaveBeenCalledWith(
      expect.objectContaining({ withinMs: 30 * MS_PER_DAY }),
    );
  });

  it('accepts withinDays=0 for "already lapsed only"', async () => {
    await GET(makeRequest('?withinDays=0') as never);

    expect(mockListRenewableGrants).toHaveBeenCalledWith(
      expect.objectContaining({ withinMs: 0 }),
    );
  });

  it('rejects a non-numeric withinDays', async () => {
    const response = await GET(makeRequest('?withinDays=soon') as never);
    expect(response.status).toBe(400);
    expect(mockListRenewableGrants).not.toHaveBeenCalled();
  });

  it('rejects a negative withinDays', async () => {
    const response = await GET(makeRequest('?withinDays=-1') as never);
    expect(response.status).toBe(400);
  });

  it('surfaces a lookup failure as a 500 rather than an unhandled rejection', async () => {
    mockListRenewableGrants.mockRejectedValue(new Error('db down'));

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(500);
  });
});
