import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockDbSelect, mockDbInsert, mockDbInsertValues, mockSendEmail, mockRateLimit, mockGetClient } = vi.hoisted(() => {
  const mockDbInsertValuesInner = vi.fn(async (..._args: unknown[]) => undefined);
  return {
    mockDbSelect: vi.fn(),
    mockDbInsertValues: mockDbInsertValuesInner,
    mockDbInsert: vi.fn(() => ({ values: (...args: unknown[]) => mockDbInsertValuesInner(...args) })),
    mockSendEmail: vi.fn(async () => ({ success: true })),
    mockRateLimit: vi.fn(() => ({ limited: false, retryAfter: 0 })),
    mockGetClient: vi.fn(),
  };
});

vi.mock('@imajin/logger', () => ({
  withLogger:
    (_service: string, handler: (req: unknown, ctx: { log: unknown }) => unknown) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => ({}),
  rateLimit: mockRateLimit,
  getClientIP: () => '127.0.0.1',
  buildPublicUrlAbsolute: (service: string) => `https://${service}.example`,
}));

vi.mock('@imajin/email', () => ({
  sendEmail: mockSendEmail,
}));

vi.mock('@imajin/db', () => ({
  getClient: mockGetClient,
}));

function selectChain(result: unknown) {
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
  },
  onboardTokens: {},
  credentials: { did: 'credentials.did', type: 'credentials.type', value: 'credentials.value' },
  identities: { id: 'identities.id' },
  invites: { code: 'invites.code', scopeDid: 'invites.scope_did' },
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { POST } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeReq(body: Record<string, unknown>) {
  return {
    headers: new Headers(),
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ limited: false, retryAfter: 0 });
  mockDbInsertValues.mockResolvedValue(undefined);
});

describe('POST /api/onboard — invite context threading (#1834 Phase 2)', () => {
  const SCOPE_DID = 'did:imajin:scope-org';

  it('stores no scopeDid/inviteCode when neither is supplied (backward compatible)', async () => {
    const res = await POST(makeReq({ email: 'plain@example.com' }));

    expect(res.status).toBe(200);
    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ scopeDid: null, inviteCode: null }),
    );
  });

  it('threads an explicit scopeDid through unchanged when there is no inviteCode', async () => {
    const res = await POST(makeReq({ email: 'plain@example.com', scopeDid: SCOPE_DID }));

    expect(res.status).toBe(200);
    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ scopeDid: SCOPE_DID, inviteCode: null }),
    );
  });

  it('re-resolves scopeDid from the invite row by code, overriding any client-supplied scopeDid', async () => {
    mockDbSelect.mockImplementationOnce(() => selectChain([{ code: 'abc123', scopeDid: SCOPE_DID }]));

    const res = await POST(makeReq({
      email: 'invited@example.com',
      scopeDid: 'did:imajin:client-supplied-should-be-ignored',
      inviteCode: 'abc123',
    }));

    expect(res.status).toBe(200);
    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ scopeDid: SCOPE_DID, inviteCode: 'abc123' }),
    );
  });

  it('ignores an unknown invite code rather than blocking onboarding', async () => {
    mockDbSelect.mockImplementationOnce(() => selectChain([])); // invite lookup misses

    const res = await POST(makeReq({ email: 'invited@example.com', inviteCode: 'does-not-exist' }));

    expect(res.status).toBe(200);
    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ scopeDid: null, inviteCode: null }),
    );
  });
});

describe('POST /api/onboard — login mode security (#1871)', () => {
  const SOFT_DID = 'did:imajin:soft-user';
  const HARD_DID = 'did:imajin:hard-user';

  it('sends magic link for an existing soft-DID credential', async () => {
    mockDbSelect.mockImplementationOnce(() => selectChain([{ did: SOFT_DID }]));
    mockDbSelect.mockImplementationOnce(() => selectChain([{ tier: 'soft' }]));

    const res = await POST(makeReq({ email: 'soft@example.com', mode: 'login' }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sent).toBe(true);
  });

  it('rejects hard DIDs before writing any onboard token', async () => {
    mockDbSelect.mockImplementationOnce(() => selectChain([{ did: HARD_DID }]));
    mockDbSelect.mockImplementationOnce(() => selectChain([{ tier: 'preliminary' }]));

    const res = await POST(makeReq({ email: 'hard@example.com', mode: 'login' }));

    expect(res.status).toBe(403);
    // No token should have been inserted — the hardDid check blocks before that.
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });

  it('profile fallback is read-only and does not insert a credential (#1871)', async () => {
    // No credential hit …
    mockDbSelect.mockImplementationOnce(() => selectChain([]));
    // … but profile.profiles has a row — return it via the raw-sql mock.
    mockGetClient.mockReturnValueOnce(() => Promise.resolve([{ did: SOFT_DID }]));
    // Identity tier lookup
    mockDbSelect.mockImplementationOnce(() => selectChain([{ tier: 'soft' }]));

    const res = await POST(makeReq({ email: 'profile-only@example.com', mode: 'login' }));

    expect(res.status).toBe(200);
    // The credential table must never have been written to in login resolution.
    const credentialInserts = mockDbInsertValues.mock.calls.filter(
      (call) => call[0]?.type === 'email',
    );
    expect(credentialInserts).toHaveLength(0);
  });

  it('enumerate-protects unknown emails in login mode (no inserts, still 200)', async () => {
    mockDbSelect.mockImplementationOnce(() => selectChain([]));
    mockGetClient.mockReturnValueOnce(() => Promise.resolve([]));

    const res = await POST(makeReq({ email: 'unknown@example.com', mode: 'login' }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sent).toBe(true);
    // No onboard token should have been written for an unknown email.
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });
});
