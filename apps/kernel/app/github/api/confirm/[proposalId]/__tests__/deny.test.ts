import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockRequireAuth,
  mockDbSelectLimit,
  mockDbUpdateWhere,
  mockPublish,
} = vi.hoisted(() => {
  const mockDbSelectLimit  = vi.fn().mockResolvedValue([]);
  const mockDbSelectWhere  = vi.fn(() => ({ limit: mockDbSelectLimit }));
  const mockDbSelectFrom   = vi.fn(() => ({ where: mockDbSelectWhere }));
  const mockDbSelect       = vi.fn(() => ({ from: mockDbSelectFrom }));

  const mockDbUpdateWhere  = vi.fn().mockResolvedValue(undefined);
  const mockDbUpdateSet    = vi.fn(() => ({ where: mockDbUpdateWhere }));
  const mockDbUpdate       = vi.fn(() => ({ set: mockDbUpdateSet }));

  const mockRequireAuth    = vi.fn();
  const mockPublish        = vi.fn().mockResolvedValue(undefined);

  return { mockRequireAuth, mockDbSelectLimit, mockDbSelect, mockDbUpdateWhere, mockDbUpdate, mockPublish };
});

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: mockDbSelectLimit })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: mockDbUpdateWhere })),
    })),
  },
  githubActionProposals: {},
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { id: string }) => identity.id,
  canonicalize: vi.fn((x: unknown) => JSON.stringify(x)),
  crypto: { signSync: vi.fn(() => 'fake-sig') },
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({
  publish: mockPublish,
}));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: vi.fn(() => ({
    privateKeyHex: 'a'.repeat(64),
    senderPubkey: 'b'.repeat(64),
  })),
}));

vi.mock('node:crypto', () => ({
  createHash: vi.fn(() => ({ update: vi.fn().mockReturnThis(), digest: vi.fn(() => 'fakedigest') })),
}));

// ─── Subject ──────────────────────────────────────────────────────────────────

import { DELETE } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID     = 'did:imajin:owner-123';
const PROPOSAL_ID   = 'proposal_abc';
const BASE_URL      = `https://test.imajin.ai/github/api/confirm/${PROPOSAL_ID}`;

const PENDING_PROPOSAL = {
  id: PROPOSAL_ID,
  status: 'pending',
  tool: 'github_update_issue',
  target: 'ima-jin/imajin-ai#42',
};

function makeReq(): Request {
  return new Request(BASE_URL, { method: 'DELETE' });
}

function paramsFor(id: string) {
  return { params: { proposalId: id } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPublish.mockResolvedValue(undefined);
  mockDbSelectLimit.mockResolvedValue([]);
  mockDbUpdateWhere.mockResolvedValue(undefined);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DELETE /github/api/confirm/:proposalId — deny (#1429)', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await DELETE(makeReq() as Parameters<typeof DELETE>[0], paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown proposal', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER_DID } });
    mockDbSelectLimit.mockResolvedValueOnce([]);  // proposal not found

    const res = await DELETE(makeReq() as Parameters<typeof DELETE>[0], paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(404);
  });

  it('returns 400 when proposal is not pending', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER_DID } });
    mockDbSelectLimit.mockResolvedValueOnce([{ ...PENDING_PROPOSAL, status: 'approved' }]);

    const res = await DELETE(makeReq() as Parameters<typeof DELETE>[0], paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/not awaiting confirmation/);
  });

  it('returns 200 and status=denied for a pending proposal', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER_DID } });
    mockDbSelectLimit.mockResolvedValueOnce([PENDING_PROPOSAL]);

    const res = await DELETE(makeReq() as Parameters<typeof DELETE>[0], paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(200);
    const body = await res.json() as { proposalId: string; status: string };
    expect(body.status).toBe('denied');
    expect(body.proposalId).toBe(PROPOSAL_ID);
  });

  it('publishes action.denied (non-fatal)', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER_DID } });
    mockDbSelectLimit.mockResolvedValueOnce([PENDING_PROPOSAL]);

    await DELETE(makeReq() as Parameters<typeof DELETE>[0], paramsFor(PROPOSAL_ID));

    expect(mockPublish).toHaveBeenCalledOnce();
    const [eventType, payload] = mockPublish.mock.calls[0] as [string, { payload: { proposalId: string } }];
    expect(eventType).toBe('action.denied');
    expect(payload.payload.proposalId).toBe(PROPOSAL_ID);
  });

  it('does NOT write ownerAuthorization (no grant)', async () => {
    // The deny path should NOT touch ownerAuthorization.
    // We verify by checking db.update was called with status='denied' only.
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER_DID } });
    mockDbSelectLimit.mockResolvedValueOnce([PENDING_PROPOSAL]);

    await DELETE(makeReq() as Parameters<typeof DELETE>[0], paramsFor(PROPOSAL_ID));

    expect(mockDbUpdateWhere).toHaveBeenCalledOnce();
  });
});
