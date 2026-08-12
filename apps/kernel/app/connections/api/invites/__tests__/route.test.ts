import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockResolveEffectiveDid,
  mockGetSessionFromCookies,
  mockGetSessionForDid,
  mockDbSelect,
  mockDbInsert,
  mockPublish,
  mockIsVerifiedTier,
  mockResolveOrMintInviteTarget,
} = vi.hoisted(() => ({
  mockResolveEffectiveDid: vi.fn(),
  mockGetSessionFromCookies: vi.fn(),
  mockGetSessionForDid: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockPublish: vi.fn(async () => undefined),
  mockIsVerifiedTier: vi.fn(() => true),
  mockResolveOrMintInviteTarget: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  resolveEffectiveDid: mockResolveEffectiveDid,
  isVerifiedTier: mockIsVerifiedTier,
}));

vi.mock('@/src/lib/auth/claimable-stub', () => ({
  resolveOrMintInviteTarget: mockResolveOrMintInviteTarget,
}));

vi.mock('@/src/lib/kernel/session', () => ({
  getSessionFromCookies: mockGetSessionFromCookies,
  getSessionForDid: mockGetSessionForDid,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({
  publish: mockPublish,
}));

vi.mock('@imajin/config', () => ({
  buildPublicUrl: (service: string) => `https://${service}.example`,
}));

vi.mock('@imajin/email', () => ({
  sendEmail: vi.fn(async () => undefined),
  trustGraphInviteEmail: vi.fn(() => '<html></html>'),
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}test123`,
}));

// Chainable drizzle-style query builder mock. Each test configures the
// resolved value for the queries it cares about via mockDbSelect/mockDbInsert.
function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.from = vi.fn(self);
  chain.where = vi.fn(self);
  chain.limit = vi.fn(async () => result);
  chain.orderBy = vi.fn(async () => result);
  chain.leftJoin = vi.fn(self);
  // `where` resolves directly for the pending-count query (no `.limit()` call).
  chain.then = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

vi.mock('@/src/db', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
  invites: {},
  profiles: {},
  podMembers: {},
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { POST } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:owner';

const SESSION = {
  did: OWNER_DID,
  handle: 'owner-handle',
  scope: 'actor',
  role: 'member',
  tier: 'established',
  chainVerified: true,
};

type RouteRequest = Parameters<typeof POST>[0];

function makeReq(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): RouteRequest {
  return {
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as RouteRequest;
}

const UNAUTHENTICATED = {
  ok: false,
  status: 401,
  error: 'Unauthorized',
};

function appAuthOk() {
  return { ok: true, effectiveDid: OWNER_DID, via: 'app', composedBy: null };
}

function sessionAuthOk() {
  return { ok: true, effectiveDid: OWNER_DID, via: 'session', composedBy: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveEffectiveDid.mockResolvedValue(sessionAuthOk());
  mockGetSessionFromCookies.mockResolvedValue(SESSION);
  mockGetSessionForDid.mockResolvedValue(SESSION);

  // Default select chain: no pending invites, count = 0.
  mockDbSelect.mockImplementation(() => makeSelectChain([{ count: 0 }]));
  mockDbInsert.mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn(async () => [
        { id: 'inv_test123', code: 'abc123', fromDid: OWNER_DID, delivery: 'link' },
      ]),
    }),
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /connections/api/invites — dual guard via resolveEffectiveDid (#1832)', () => {
  it('creates a link invite for a cookie/session-authenticated user', async () => {
    const res = await POST(makeReq({}));

    expect(res.status).toBe(201);
    expect(mockResolveEffectiveDid).toHaveBeenCalledWith(
      expect.anything(),
      { scope: 'connections:write' },
    );
    expect(mockGetSessionForDid).toHaveBeenCalledWith(OWNER_DID);
    expect(mockDbInsert).toHaveBeenCalled();
  });

  it('returns 401 when there is no session and no app credentials', async () => {
    mockResolveEffectiveDid.mockResolvedValueOnce(UNAUTHENTICATED);

    const res = await POST(makeReq({}));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('creates the invite for an app token with the connections:write scope', async () => {
    mockResolveEffectiveDid.mockResolvedValueOnce(appAuthOk());

    const res = await POST(makeReq({}));

    expect(res.status).toBe(201);
    expect(mockGetSessionForDid).toHaveBeenCalledWith(OWNER_DID);

    const insertValues = mockDbInsert.mock.results[0].value.values as ReturnType<typeof vi.fn>;
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ fromDid: OWNER_DID }),
    );
  });

  it('rejects an app token missing the connections:write scope with 403, not a generic 401', async () => {
    mockResolveEffectiveDid.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: "Scope 'connections:write' was not granted",
    });

    const res = await POST(makeReq({}));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Scope 'connections:write' was not granted" });
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('returns 401 when the effective DID has no known identity', async () => {
    mockResolveEffectiveDid.mockResolvedValueOnce(appAuthOk());
    mockGetSessionForDid.mockResolvedValueOnce(null);

    const res = await POST(makeReq({}));

    expect(res.status).toBe(401);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('resolves the same issuer DID via the app-auth and session paths', async () => {
    mockResolveEffectiveDid.mockResolvedValueOnce(appAuthOk());
    const appRes = await POST(makeReq({}));
    const appBody = await appRes.json();

    mockResolveEffectiveDid.mockResolvedValueOnce(sessionAuthOk());
    const sessionRes = await POST(makeReq({}));
    const sessionBody = await sessionRes.json();

    expect(appBody.invite.fromDid).toBe(OWNER_DID);
    expect(sessionBody.invite.fromDid).toBe(OWNER_DID);
  });
});

describe('POST /connections/api/invites — mint-on-new-email (#1834 Phase 1)', () => {
  const NEW_STUB_DID = 'did:imajin:new-stub';
  const SENDER_PROFILE = {
    did: OWNER_DID,
    displayName: 'Owner',
    handle: 'owner-handle',
    nextInviteAvailableAt: null,
  };

  // Email-invite branch calls db.select() in this order:
  //   1. isInTrustGraph (podMembers membership check)
  //   2. sender profile lookup (cooldown + display info)
  //   3. pending email invite count
  function queueEmailBranchSelects() {
    mockDbSelect
      .mockImplementationOnce(() => makeSelectChain([{ podId: 'pod_1' }]))
      .mockImplementationOnce(() => makeSelectChain([SENDER_PROFILE]))
      .mockImplementationOnce(() => makeSelectChain([{ value: 0 }]));
  }

  beforeEach(() => {
    mockResolveOrMintInviteTarget.mockResolvedValue(NEW_STUB_DID);
    queueEmailBranchSelects();
    mockDbInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn(async () => [
          { id: 'inv_test123', code: 'abc123', fromDid: OWNER_DID, toDid: NEW_STUB_DID, delivery: 'email' },
        ]),
      }),
    });
  });

  it('resolves the invite target via resolveOrMintInviteTarget and stores it as toDid at creation time', async () => {
    const res = await POST(makeReq({ delivery: 'email', toEmail: 'new@example.com' }));

    expect(res.status).toBe(201);
    expect(mockResolveOrMintInviteTarget).toHaveBeenCalledWith('new@example.com');
    const insertValues = mockDbInsert.mock.results[0].value.values as ReturnType<typeof vi.fn>;
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ toDid: NEW_STUB_DID }));
  });

  it('returns an identical response shape for a brand-new email and a silently-accrued repeat introduction', async () => {
    const firstRes = await POST(makeReq({ delivery: 'email', toEmail: 'shared@example.com' }));
    const firstBody = await firstRes.json();

    // Second introducer of the SAME email: resolveOrMintInviteTarget silently
    // returns the SAME stub DID with nothing distinguishing this from the
    // first-time mint above (match-without-disclosure, #1834 design pt. 2).
    queueEmailBranchSelects();
    const secondRes = await POST(makeReq({ delivery: 'email', toEmail: 'shared@example.com' }));
    const secondBody = await secondRes.json();

    expect(secondRes.status).toBe(firstRes.status);
    expect(Object.keys(secondBody).sort()).toEqual(Object.keys(firstBody).sort());
    expect(Object.keys(secondBody.invite).sort()).toEqual(Object.keys(firstBody.invite).sort());
  });
});
