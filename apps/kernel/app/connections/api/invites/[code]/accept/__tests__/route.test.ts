import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockGetSessionFromCookies,
  mockIsUnclaimedStub,
  mockTryActivateClaim,
  mockDbSelect,
  mockDbInsert,
  mockDbUpdate,
  mockPublish,
  mockCheckPreliminaryEligibility,
  mockCheckHardEligibility,
} = vi.hoisted(() => ({
  mockGetSessionFromCookies: vi.fn(),
  mockIsUnclaimedStub: vi.fn(),
  mockTryActivateClaim: vi.fn(async () => false),
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockPublish: vi.fn(async () => undefined),
  mockCheckPreliminaryEligibility: vi.fn(async () => undefined),
  mockCheckHardEligibility: vi.fn(async () => undefined),
}));

vi.mock('@/src/lib/kernel/session', () => ({
  getSessionFromCookies: mockGetSessionFromCookies,
}));

vi.mock('@/src/lib/auth/claimable-stub', () => ({
  isUnclaimedStub: mockIsUnclaimedStub,
  tryActivateClaim: mockTryActivateClaim,
}));

vi.mock('@/src/lib/kernel/verification', () => ({
  checkPreliminaryEligibility: mockCheckPreliminaryEligibility,
  checkHardEligibility: mockCheckHardEligibility,
}));

vi.mock('@imajin/bus', () => ({
  publish: mockPublish,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}test123`,
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
    insert: (...args: unknown[]) => mockDbInsert(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
  },
  invites: {},
  profiles: {},
  pods: {},
  podMembers: {},
  connections: {},
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { POST } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const INVITER_DID = 'did:imajin:inviter';
const ACCEPTER_DID = 'did:imajin:accepter';
const STUB_DID = 'did:imajin:new-stub';
const CODE = 'abc123';

const SESSION = {
  did: ACCEPTER_DID,
  handle: 'accepter-handle',
  scope: 'actor',
  role: 'member',
  tier: 'preliminary',
  chainVerified: true,
};

function baseInvite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv_1',
    code: CODE,
    fromDid: INVITER_DID,
    fromHandle: 'inviter-handle',
    toEmail: null,
    toDid: null,
    note: null,
    delivery: 'link',
    status: 'pending',
    usedCount: 0,
    maxUses: 1,
    expiresAt: null,
    ...overrides,
  };
}

type RouteRequest = Parameters<typeof POST>[0];

function makeReq(headers: Record<string, string> = {}): RouteRequest {
  return { headers: new Headers(headers) } as unknown as RouteRequest;
}

function makeParams(code: string) {
  return { params: Promise.resolve({ code }) };
}

/**
 * Queue the db.select() calls the happy path makes, in order, after the
 * initial invite lookup:
 *   1. (email invites only) invitee profile lookup for the isForUser check
 *   2. existing-connection lookup (sybil check)
 *   3. inviter profile lookup (fire-and-forget notify block)
 */
function queueAcceptSelects(opts: {
  delivery?: 'link' | 'email';
  inviteeProfile?: unknown;
  existingConn?: unknown;
} = {}) {
  if (opts.delivery === 'email') {
    mockDbSelect.mockImplementationOnce(() => makeSelectChain(opts.inviteeProfile ? [opts.inviteeProfile] : []));
  }
  mockDbSelect.mockImplementationOnce(() => makeSelectChain(opts.existingConn ? [opts.existingConn] : []));
  mockDbSelect.mockImplementationOnce(() => makeSelectChain([{ contactEmail: 'inviter@example.com' }]));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionFromCookies.mockResolvedValue(null);
  mockIsUnclaimedStub.mockResolvedValue(false);
  mockTryActivateClaim.mockResolvedValue(false);

  mockDbInsert.mockReturnValue({ values: vi.fn(async () => undefined) });
  mockDbUpdate.mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn(async () => undefined) }) });
});

describe('POST /connections/api/invites/[code]/accept — session auth (existing behaviour)', () => {
  it('returns 401 with no session and no unclaimed-stub target', async () => {
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([baseInvite()]));

    const res = await POST(makeReq(), makeParams(CODE));

    expect(res.status).toBe(401);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('accepts a link invite for a cookie-authenticated user', async () => {
    mockGetSessionFromCookies.mockResolvedValue(SESSION);
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([baseInvite()]));
    queueAcceptSelects();

    const res = await POST(makeReq(), makeParams(CODE));

    expect(res.status).toBe(201);
    expect(mockTryActivateClaim).not.toHaveBeenCalled(); // link invites never touch the claim ratchet
  });

  it('rejects accepting your own invite', async () => {
    mockGetSessionFromCookies.mockResolvedValue({ ...SESSION, did: INVITER_DID });
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([baseInvite()]));

    const res = await POST(makeReq(), makeParams(CODE));

    expect(res.status).toBe(400);
  });
});

describe('POST /connections/api/invites/[code]/accept — unauthenticated stub accept (#1834 Phase 1)', () => {
  it('accepts an email invite as the pre-minted claimable stub when no session is present', async () => {
    mockIsUnclaimedStub.mockResolvedValue(true);
    mockDbSelect.mockImplementationOnce(() =>
      makeSelectChain([baseInvite({ delivery: 'email', toEmail: 'new@example.com', toDid: STUB_DID })]),
    );
    queueAcceptSelects({ delivery: 'email' });

    const res = await POST(makeReq(), makeParams(CODE));

    expect(res.status).toBe(201);
    expect(mockIsUnclaimedStub).toHaveBeenCalledWith(STUB_DID);
    // The pod/connection formed under the stub's own DID, not a session DID.
    const podValues = mockDbInsert.mock.results[0].value.values as ReturnType<typeof vi.fn>;
    expect(podValues).toHaveBeenCalledWith(expect.objectContaining({ ownerDid: INVITER_DID }));
  });

  it('never lets an anonymous click accept as a soft DID that is not one of our claimable stubs', async () => {
    mockIsUnclaimedStub.mockResolvedValue(false); // some other soft DID, not our stub
    mockDbSelect.mockImplementationOnce(() =>
      makeSelectChain([baseInvite({ delivery: 'email', toEmail: 'new@example.com', toDid: 'did:imajin:some-other-soft-did' })]),
    );

    const res = await POST(makeReq(), makeParams(CODE));

    expect(res.status).toBe(401);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('link invites are never eligible for the unauthenticated stub-accept path, even with a toDid', async () => {
    mockDbSelect.mockImplementationOnce(() =>
      makeSelectChain([baseInvite({ delivery: 'link', toDid: STUB_DID })]),
    );

    const res = await POST(makeReq(), makeParams(CODE));

    expect(res.status).toBe(401);
    expect(mockIsUnclaimedStub).not.toHaveBeenCalled();
  });
});

describe('POST /connections/api/invites/[code]/accept — claim ratchet wiring (#1834 Phase 1)', () => {
  it('calls tryActivateClaim after accepting an email invite — this accept IS the inviter-side countersign', async () => {
    mockIsUnclaimedStub.mockResolvedValue(true);
    mockDbSelect.mockImplementationOnce(() =>
      makeSelectChain([baseInvite({ delivery: 'email', toEmail: 'new@example.com', toDid: STUB_DID })]),
    );
    queueAcceptSelects({ delivery: 'email' });

    await POST(makeReq(), makeParams(CODE));

    expect(mockTryActivateClaim).toHaveBeenCalledWith(STUB_DID);
  });

  it('unverified click alone does not activate the claim (tryActivateClaim reports false; identity stays soft)', async () => {
    mockIsUnclaimedStub.mockResolvedValue(true);
    mockTryActivateClaim.mockResolvedValue(false); // claimant has not verified their email yet
    mockDbSelect.mockImplementationOnce(() =>
      makeSelectChain([baseInvite({ delivery: 'email', toEmail: 'new@example.com', toDid: STUB_DID })]),
    );
    queueAcceptSelects({ delivery: 'email' });

    const res = await POST(makeReq(), makeParams(CODE));

    expect(res.status).toBe(201); // the connection still forms...
    expect(mockTryActivateClaim).toHaveBeenCalledWith(STUB_DID); // ...but the ratchet did not close
  });
});
