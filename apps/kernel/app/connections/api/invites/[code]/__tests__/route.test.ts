import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockResolveEffectiveDid, mockDbSelect, mockDbUpdate } = vi.hoisted(() => ({
  mockResolveEffectiveDid: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  resolveEffectiveDid: mockResolveEffectiveDid,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: vi.fn(),
}));

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.from = vi.fn(self);
  chain.where = vi.fn(self);
  chain.limit = vi.fn(async () => result);
  chain.then = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

vi.mock('@/src/db', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
  },
  invites: {},
  profiles: {},
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { GET, DELETE } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CODE = 'abc123';
const OWNER_DID = 'did:imajin:owner';
const SCOPE_DID = 'did:imajin:scope-org';

function baseInvite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv_1',
    code: CODE,
    fromDid: OWNER_DID,
    fromHandle: 'owner-handle',
    note: null,
    usedCount: 0,
    maxUses: 1,
    status: 'pending',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    delivery: 'link',
    scopeDid: null,
    ...overrides,
  };
}

type GetRequest = Parameters<typeof GET>[0];
type DeleteRequest = Parameters<typeof DELETE>[0];

function makeReq(headers: Record<string, string> = {}) {
  return { headers: new Headers(headers) } as unknown as GetRequest & DeleteRequest;
}

function makeParams(code: string) {
  return { params: Promise.resolve({ code }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveEffectiveDid.mockResolvedValue({ ok: false, error: 'Unauthorized', status: 401 });
  mockDbUpdate.mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn(async () => undefined) }) });
});

describe('GET /connections/api/invites/[code] — invite context extension (#1834 Phase 2)', () => {
  it('exposes scopeDid on the public invite response', async () => {
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([baseInvite({ scopeDid: SCOPE_DID })]));

    const res = await GET(makeReq(), makeParams(CODE));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.scopeDid).toBe(SCOPE_DID);
  });

  it('returns null scopeDid for an unscoped invite, backward compatible', async () => {
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([baseInvite()]));

    const res = await GET(makeReq(), makeParams(CODE));
    const body = await res.json();

    expect(body.scopeDid).toBeNull();
  });

  it('returns 404 for an unknown invite code', async () => {
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([]));

    const res = await GET(makeReq(), makeParams('missing'));

    expect(res.status).toBe(404);
  });
});

describe('DELETE /connections/api/invites/[code]', () => {
  it('returns 401 when there is no session', async () => {
    // resolveEffectiveDid is checked before any db lookup — no select is queued.
    const res = await DELETE(makeReq(), makeParams(CODE));

    expect(res.status).toBe(401);
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller does not own the invite', async () => {
    mockResolveEffectiveDid.mockResolvedValue({ ok: true, effectiveDid: 'did:imajin:someone-else' });
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([baseInvite()]));

    const res = await DELETE(makeReq(), makeParams(CODE));

    expect(res.status).toBe(403);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('revokes a pending invite for its owner', async () => {
    mockResolveEffectiveDid.mockResolvedValue({ ok: true, effectiveDid: OWNER_DID });
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([baseInvite()]));

    const res = await DELETE(makeReq(), makeParams(CODE));

    expect(res.status).toBe(200);
    expect(mockDbUpdate).toHaveBeenCalled();
  });

  it('rejects revoking an invite that is not pending', async () => {
    mockResolveEffectiveDid.mockResolvedValue({ ok: true, effectiveDid: OWNER_DID });
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([baseInvite({ status: 'accepted' })]));

    const res = await DELETE(makeReq(), makeParams(CODE));

    expect(res.status).toBe(400);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });
});
