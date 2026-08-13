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
  // Real implementation — the route's no-disclosure contract (#1839) is
  // exactly what these tests are verifying, so it must not be stubbed out.
  withNoDisclosure: <T extends { toDid: string | null; status: string }>(invite: T): T =>
    invite.status === 'accepted' ? invite : { ...invite, toDid: null },
}));

vi.mock('@/src/lib/kernel/session', () => ({
  getSessionFromCookies: mockGetSessionFromCookies,
  getSessionForDid: mockGetSessionForDid,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  // withLogger (#1847): the route now wraps POST for request-complete
  // logging/observability. The test double skips correlation-id/timing
  // plumbing and just invokes the handler with a stub logger context.
  withLogger: (_service: string, handler: (req: unknown, ctx: { log: ReturnType<typeof createStubLog>; correlationId: string }) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: createStubLog(), correlationId: 'cor_test' }),
}));

function createStubLog() {
  return { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

vi.mock('@imajin/bus', () => ({
  publish: mockPublish,
}));

vi.mock('@imajin/config', () => ({
  buildPublicUrl: (service: string) => `https://${service}.example`,
}));

vi.mock('@imajin/email', () => ({
  sendEmail: vi.fn(async () => ({ success: true, messageId: 'msg_test' })),
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

// `db.select(...).from(...).leftJoin(...).where(...).orderBy(...)` — the GET
// (list) shape — resolves via `.orderBy()` rather than `.then()`/`.limit()`.
function makeListChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.from = vi.fn(self);
  chain.leftJoin = vi.fn(self);
  chain.where = vi.fn(self);
  chain.orderBy = vi.fn(async () => result);
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
  identities: { id: 'identities.id' },
  attestations: {
    id: 'attestations.id',
    issuerDid: 'attestations.issuer_did',
    subjectDid: 'attestations.subject_did',
    attestationStatus: 'attestations.attestation_status',
  },
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { POST, GET } from '../route';
import { sendEmail } from '@imajin/email';

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

  it('resolves the invite target via resolveOrMintInviteTarget and STORES it as toDid — internally only', async () => {
    const res = await POST(makeReq({ delivery: 'email', toEmail: 'new@example.com' }));

    expect(res.status).toBe(201);
    expect(mockResolveOrMintInviteTarget).toHaveBeenCalledWith('new@example.com');
    const insertValues = mockDbInsert.mock.results[0].value.values as ReturnType<typeof vi.fn>;
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ toDid: NEW_STUB_DID }));
  });

  it('never returns toDid in the create response — no-disclosure (#1839)', async () => {
    const res = await POST(makeReq({ delivery: 'email', toEmail: 'new@example.com' }));
    const body = await res.json();

    expect(body.invite.toDid).toBeNull();
    expect(body).not.toHaveProperty('tier');
  });

  it('returns an identical response shape for a brand-new email and a silently-accrued repeat introduction, with toDid stripped either way', async () => {
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
    expect(firstBody.invite.toDid).toBeNull();
    expect(secondBody.invite.toDid).toBeNull();
  });

  it('never returns toDid for a link invite response either, for shape consistency', async () => {
    const res = await POST(makeReq({}));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.invite.toDid).toBeNull();
  });
});

describe('POST /connections/api/invites — emailSent observability (#1847)', () => {
  const NEW_STUB_DID = 'did:imajin:new-stub';
  const SENDER_PROFILE = {
    did: OWNER_DID,
    displayName: 'Owner',
    handle: 'owner-handle',
    nextInviteAvailableAt: null,
  };

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

  it('returns emailSent: true when the Postal delivery succeeds', async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce({ success: true, messageId: 'msg_ok' });

    const res = await POST(makeReq({ delivery: 'email', toEmail: 'new@example.com' }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.emailSent).toBe(true);
  });

  it('returns emailSent: false without failing the request when the provider reports a failure', async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce({ success: false, error: 'Postal 500: Internal Server Error' });

    const res = await POST(makeReq({ delivery: 'email', toEmail: 'new@example.com' }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.emailSent).toBe(false);
    expect(body.invite).toBeDefined();
  });

  it('returns emailSent: false without failing the request when sendEmail throws', async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('network error'));

    const res = await POST(makeReq({ delivery: 'email', toEmail: 'new@example.com' }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.emailSent).toBe(false);
  });
});

describe('GET /connections/api/invites — no-disclosure list masking (#1839)', () => {
  const INVITER_DID = OWNER_DID;
  const REAL_TARGET_DID = 'did:imajin:real-target';

  function pendingEmailInviteRow(overrides: Record<string, unknown> = {}) {
    return {
      invite: {
        id: 'inv_pending',
        code: 'code_pending',
        fromDid: INVITER_DID,
        toEmail: 'target@example.com',
        toDid: REAL_TARGET_DID,
        delivery: 'email',
        status: 'pending',
        createdAt: new Date().toISOString(),
        ...overrides,
      },
      // The email happens to belong to an existing, already-profiled real
      // user — this is the sharpest oracle case (#1839): the leftJoin finds a
      // profile row purely because toDid resolved to a real identity, even
      // though the invite has not been accepted.
      acceptedHandle: 'real-user-handle',
      acceptedName: 'Real User',
    };
  }

  function acceptedEmailInviteRow(overrides: Record<string, unknown> = {}) {
    return {
      invite: {
        id: 'inv_accepted',
        code: 'code_accepted',
        fromDid: INVITER_DID,
        toEmail: 'friend@example.com',
        toDid: REAL_TARGET_DID,
        delivery: 'email',
        status: 'accepted',
        createdAt: new Date().toISOString(),
        ...overrides,
      },
      acceptedHandle: 'friend-handle',
      acceptedName: 'Friend',
    };
  }

  function makeGetReq(): Parameters<typeof GET>[0] {
    return { headers: new Headers({ cookie: 'session=x' }) } as unknown as Parameters<typeof GET>[0];
  }

  it('never discloses toDid, acceptedBy, or acceptedHandle for a pending invite — even when toDid resolved to a real, already-profiled user', async () => {
    mockGetSessionFromCookies.mockResolvedValue(SESSION);
    // `mockReset` (not `mockImplementationOnce`) so a queued-but-unconsumed
    // once-callback left over from an earlier POST test can't silently take
    // priority over this test's single db.select() call.
    mockDbSelect.mockReset();
    mockDbSelect.mockImplementation(() => makeListChain([pendingEmailInviteRow()]));

    const res = await GET(makeGetReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.invites).toHaveLength(1);
    const row = body.invites[0];
    expect(row.toDid).toBeNull();
    expect(row.acceptedBy).toBeNull();
    expect(row.acceptedHandle).toBeNull();
  });

  it('discloses toDid and the accepted-by profile once the invite has actually been accepted (#1839 pt. 4)', async () => {
    mockGetSessionFromCookies.mockResolvedValue(SESSION);
    mockDbSelect.mockReset();
    mockDbSelect.mockImplementation(() => makeListChain([acceptedEmailInviteRow()]));

    const res = await GET(makeGetReq());
    const body = await res.json();

    const row = body.invites[0];
    expect(row.toDid).toBe(REAL_TARGET_DID);
    expect(row.acceptedBy).toBe('friend-handle');
    expect(row.acceptedHandle).toBe('friend-handle');
  });

  it('returns 401 for an unrelated, unauthenticated caller — no list data leaks without a session', async () => {
    mockGetSessionFromCookies.mockResolvedValue(null);

    const res = await GET(makeGetReq());

    expect(res.status).toBe(401);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });
});

describe('POST /connections/api/invites — invite context extension (#1834 Phase 2)', () => {
  const SCOPE_DID = 'did:imajin:scope-org';
  const ATTESTATION_ID = 'att_pending123';
  const NEW_STUB_DID = 'did:imajin:new-stub';
  const SENDER_PROFILE = {
    did: OWNER_DID,
    displayName: 'Owner',
    handle: 'owner-handle',
    nextInviteAvailableAt: null,
  };

  // After context validation, the email-invite branch calls db.select() in
  // this order: isInTrustGraph, sender profile lookup, pending count.
  function queueEmailBranchSelects() {
    mockDbSelect
      .mockImplementationOnce(() => makeSelectChain([{ podId: 'pod_1' }]))
      .mockImplementationOnce(() => makeSelectChain([SENDER_PROFILE]))
      .mockImplementationOnce(() => makeSelectChain([{ value: 0 }]));
  }

  beforeEach(() => {
    mockResolveOrMintInviteTarget.mockResolvedValue(NEW_STUB_DID);
    mockDbInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn(async () => [
          {
            id: 'inv_test123',
            code: 'abc123',
            fromDid: OWNER_DID,
            toDid: NEW_STUB_DID,
            delivery: 'email',
            scopeDid: SCOPE_DID,
            pendingAttestationId: ATTESTATION_ID,
          },
        ]),
      }),
    });
  });

  it('creates an invite without context fields, backward compatible', async () => {
    queueEmailBranchSelects();

    const res = await POST(makeReq({ delivery: 'email', toEmail: 'plain@example.com' }));

    expect(res.status).toBe(201);
    const insertValues = mockDbInsert.mock.results[0].value.values as ReturnType<typeof vi.fn>;
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ scopeDid: null, pendingAttestationId: null }),
    );
  });

  it('creates an invite with a valid scopeDid + pendingAttestationId and persists both', async () => {
    mockDbSelect
      .mockImplementationOnce(() => makeSelectChain([{ id: SCOPE_DID }])) // scopeDid identity lookup
      .mockImplementationOnce(() =>
        makeSelectChain([{ issuerDid: OWNER_DID, subjectDid: 'did:imajin:other', status: 'pending' }]),
      ); // pendingAttestationId lookup — inviter is the issuer
    queueEmailBranchSelects();

    const res = await POST(makeReq({
      delivery: 'email',
      toEmail: 'new@example.com',
      scopeDid: SCOPE_DID,
      pendingAttestationId: ATTESTATION_ID,
    }));

    expect(res.status).toBe(201);
    const insertValues = mockDbInsert.mock.results[0].value.values as ReturnType<typeof vi.fn>;
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ scopeDid: SCOPE_DID, pendingAttestationId: ATTESTATION_ID }),
    );
  });

  it('accepts a pendingAttestationId where the inviter is the subject rather than the issuer', async () => {
    mockDbSelect.mockImplementationOnce(() =>
      makeSelectChain([{ issuerDid: 'did:imajin:other', subjectDid: OWNER_DID, status: 'pending' }]),
    );
    queueEmailBranchSelects();

    const res = await POST(makeReq({ delivery: 'email', toEmail: 'new@example.com', pendingAttestationId: ATTESTATION_ID }));

    expect(res.status).toBe(201);
  });

  it('rejects an unknown scopeDid with 400 and does not create the invite', async () => {
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([])); // scopeDid lookup misses

    const res = await POST(makeReq({ delivery: 'email', toEmail: 'new@example.com', scopeDid: 'did:imajin:unknown' }));

    expect(res.status).toBe(400);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('rejects a nonexistent pendingAttestationId with 400', async () => {
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([])); // attestation lookup misses

    const res = await POST(makeReq({ delivery: 'email', toEmail: 'new@example.com', pendingAttestationId: 'att_missing' }));

    expect(res.status).toBe(400);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('rejects a pendingAttestationId that is not pending with 400', async () => {
    mockDbSelect.mockImplementationOnce(() =>
      makeSelectChain([{ issuerDid: OWNER_DID, subjectDid: 'did:imajin:other', status: 'bilateral' }]),
    );

    const res = await POST(makeReq({ delivery: 'email', toEmail: 'new@example.com', pendingAttestationId: ATTESTATION_ID }));

    expect(res.status).toBe(400);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('rejects a pendingAttestationId the inviter is not a party to with 403', async () => {
    mockDbSelect.mockImplementationOnce(() =>
      makeSelectChain([{ issuerDid: 'did:imajin:someone-else', subjectDid: 'did:imajin:another', status: 'pending' }]),
    );

    const res = await POST(makeReq({ delivery: 'email', toEmail: 'new@example.com', pendingAttestationId: ATTESTATION_ID }));

    expect(res.status).toBe(403);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('supports context on link invites too', async () => {
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([{ id: SCOPE_DID }])); // scopeDid lookup
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([{ count: 0 }])); // pending link-invite count

    const res = await POST(makeReq({ scopeDid: SCOPE_DID }));

    expect(res.status).toBe(201);
    const insertValues = mockDbInsert.mock.results[0].value.values as ReturnType<typeof vi.fn>;
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ scopeDid: SCOPE_DID }));
  });
});
