import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockDbSelect,
  mockDbInsert,
  mockRateLimit,
  mockVerifyRegistrationSignature,
  mockResolveInviteCode,
  mockDidFromPublicKey,
  mockCreateSessionToken,
  mockGetSessionCookieOptions,
  mockGetNodeDid,
  mockAutoAcceptInvite,
  mockLinkDfosChainSafe,
  mockSubscribeEmailToMailingList,
  mockPublish,
  mockNanoid,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockRateLimit: vi.fn(() => ({ limited: false, retryAfter: 0 })),
  mockVerifyRegistrationSignature: vi.fn(async () => true),
  mockResolveInviteCode: vi.fn(async () => ({ ok: true, inviteData: null })),
  mockDidFromPublicKey: vi.fn((pk: string) => `did:imajin:${pk.slice(0, 8)}`),
  mockCreateSessionToken: vi.fn(async () => 'mock-token'),
  mockGetSessionCookieOptions: vi.fn(() => ({ name: 'session', options: { httpOnly: true } })),
  mockGetNodeDid: vi.fn(async () => 'did:imajin:node'),
  mockAutoAcceptInvite: vi.fn(async () => ({ ok: false, error: 'skip' })),
  mockLinkDfosChainSafe: vi.fn(async () => false),
  mockSubscribeEmailToMailingList: vi.fn(),
  mockPublish: vi.fn(async () => undefined),
  mockNanoid: vi.fn(() => 'mocknanoid123'),
}));

vi.mock('@imajin/config', () => ({
  rateLimit: mockRateLimit,
  getClientIP: () => '127.0.0.1',
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({
  publish: mockPublish,
}));

vi.mock('nanoid', () => ({
  nanoid: mockNanoid,
}));

vi.mock('@/src/lib/auth/crypto', () => ({
  didFromPublicKey: mockDidFromPublicKey,
}));

vi.mock('@/src/lib/auth/jwt', () => ({
  createSessionToken: mockCreateSessionToken,
  getSessionCookieOptions: mockGetSessionCookieOptions,
}));

vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: mockGetNodeDid,
}));

vi.mock('@/src/lib/auth/register', () => ({
  verifyRegistrationSignature: mockVerifyRegistrationSignature,
  resolveInviteCode: mockResolveInviteCode,
  autoAcceptInvite: mockAutoAcceptInvite,
  linkDfosChainSafe: mockLinkDfosChainSafe,
  subscribeEmailToMailingList: mockSubscribeEmailToMailingList,
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

function insertChain(returningValue: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.values = vi.fn(self);
  chain.onConflictDoNothing = vi.fn(self);
  chain.returning = vi.fn(async () => returningValue);
  chain.then = (resolve: (v: unknown) => void) => resolve(undefined);
  return chain;
}

vi.mock('@/src/db', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
  identities: { id: 'identities.id', publicKey: 'identities.publicKey', handle: 'identities.handle' },
  profiles: { did: 'profiles.did' },
  credentials: { did: 'credentials.did', type: 'credentials.type', value: 'credentials.value' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  or: (...args: unknown[]) => ({ or: args }),
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { POST } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): Parameters<typeof POST>[0] {
  return {
    headers: new Headers(),
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

const VALID_BODY = {
  publicKey: 'aabbccdd11223344',
  handle: 'alice',
  name: 'Alice',
  scope: 'actor',
  subtype: 'human',
  signature: 'sigsig',
  inviteCode: 'INVITE123',
};

const IDENTITY = {
  id: 'did:imajin:aabbccdd',
  handle: 'alice',
  scope: 'actor',
  subtype: 'human',
  name: 'Alice',
  publicKey: 'aabbccdd11223344',
  tier: 'preliminary',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ limited: false, retryAfter: 0 });
  mockVerifyRegistrationSignature.mockResolvedValue(true);
  mockResolveInviteCode.mockResolvedValue({ ok: true, inviteData: null });
  mockDbSelect.mockImplementation(() => selectChain([]));
  mockDbInsert.mockImplementation(() => insertChain([]));
  mockDidFromPublicKey.mockImplementation((pk: string) => `did:imajin:${pk.slice(0, 8)}`);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/register — auth.credentials email row (#1855)', () => {
  it('inserts an auth.credentials row with normalized email on new registration', async () => {
    mockDbInsert
      .mockImplementationOnce(() => insertChain([IDENTITY]))
      .mockImplementationOnce(() => insertChain([]))
      .mockImplementationOnce(() => insertChain([]));

    const res = await POST(makeRequest({ ...VALID_BODY, email: 'Alice@Example.COM ' }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.created).toBe(true);

    // Credentials insert (second insert call)
    const credCall = mockDbInsert.mock.calls[1];
    expect(credCall[0]).toBeDefined();
    const credChain = mockDbInsert.mock.results[1].value;
    expect(credChain.values).toHaveBeenCalledOnce();
    const credValues = credChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(credValues.type).toBe('email');
    expect(credValues.value).toBe('alice@example.com');
    expect(credValues.did).toBe(IDENTITY.id);
    expect((credValues.id as string)).toMatch(/^cred_mocknanoid/);
  });

  it('does not insert a credentials row when email is omitted', async () => {
    mockDbInsert
      .mockImplementationOnce(() => insertChain([IDENTITY]))
      .mockImplementationOnce(() => insertChain([]));

    const res = await POST(makeRequest({ ...VALID_BODY }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.created).toBe(true);

    // Only identities + profiles inserts; no credentials
    expect(mockDbInsert).toHaveBeenCalledTimes(2);
  });

  it('does not insert a credentials row when email is an empty string', async () => {
    mockDbInsert
      .mockImplementationOnce(() => insertChain([IDENTITY]))
      .mockImplementationOnce(() => insertChain([]));

    const res = await POST(makeRequest({ ...VALID_BODY, email: '' }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.created).toBe(true);

    // Only identities + profiles inserts; no credentials
    expect(mockDbInsert).toHaveBeenCalledTimes(2);
  });

  it('uses normalized email for the profile contactEmail field', async () => {
    mockDbInsert
      .mockImplementationOnce(() => insertChain([IDENTITY]))
      .mockImplementationOnce(() => insertChain([]))
      .mockImplementationOnce(() => insertChain([]));

    const res = await POST(makeRequest({ ...VALID_BODY, email: '  BOB@EXAMPLE.COM  ' }));
    expect(res.status).toBe(201);

    // Profile insert (third insert call)
    const profileChain = mockDbInsert.mock.results[2].value;
    expect(profileChain.values).toHaveBeenCalledOnce();
    const profileValues = profileChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(profileValues.contactEmail).toBe('bob@example.com');
  });

  it('uses onConflictDoNothing for the credentials insert (guards unique index)', async () => {
    mockDbInsert
      .mockImplementationOnce(() => insertChain([IDENTITY]))
      .mockImplementationOnce(() => insertChain([]))
      .mockImplementationOnce(() => insertChain([]));

    const res = await POST(makeRequest({ ...VALID_BODY, email: 'alice@example.com' }));
    expect(res.status).toBe(201);

    // Credentials insert chain should have onConflictDoNothing called
    const credChain = mockDbInsert.mock.results[1].value;
    expect(credChain.onConflictDoNothing).toHaveBeenCalledOnce();
  });
});
