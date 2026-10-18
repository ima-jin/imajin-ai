import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

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
  mockAppAuth,
  mockVerifyAppToken,
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
  mockAppAuth: vi.fn(),
  mockVerifyAppToken: vi.fn(),
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
  verifyAppToken: mockVerifyAppToken,
}));

vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: mockGetNodeDid,
}));

vi.mock('@/src/lib/kernel/app-service-auth', () => ({
  authenticatePayApp: mockAppAuth,
}));

vi.mock('@/src/lib/auth/register', async (importOriginal) => {
  // Keep the real `validateRegistrationFields`/`recordEmailCredential` implementations
  // (added when the route's field validation + credential insert were extracted into
  // this module) so this test still exercises real validation and the real
  // db.insert(credentials) call the assertions below depend on.
  const actual = await importOriginal<typeof import('@/src/lib/auth/register')>();
  return {
    ...actual,
    verifyRegistrationSignature: mockVerifyRegistrationSignature,
    resolveInviteCode: mockResolveInviteCode,
    autoAcceptInvite: mockAutoAcceptInvite,
    linkDfosChainSafe: mockLinkDfosChainSafe,
    subscribeEmailToMailingList: mockSubscribeEmailToMailingList,
  };
});

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
  registryApps: {},
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
  mockAppAuth.mockResolvedValue({ appDid: 'did:imajin:app' });
  mockVerifyAppToken.mockReset().mockResolvedValue(null);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/register — auth.credentials email row (#1855)', () => {
  it('records verified app provenance for key-backed identities, ignoring body claims', async () => {
    const chain = insertChain([IDENTITY]);
    mockDbInsert.mockImplementationOnce(() => chain);
    const request = makeRequest({ ...VALID_BODY, registeredByAppDid: 'did:imajin:spoofed' });
    request.headers.set('Authorization', 'Bearer fixture-app-token');
    expect((await POST(request)).status).toBe(201);
    expect(mockAppAuth).toHaveBeenCalledWith(request, 'identity:write');
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({ registeredByAppDid: 'did:imajin:app' }));
  });

  it('leaves signed self-registration provenance NULL', async () => {
    const chain = insertChain([IDENTITY]);
    mockDbInsert.mockImplementationOnce(() => chain);
    expect((await POST(makeRequest({ ...VALID_BODY, registeredByAppDid: 'did:imajin:spoofed' }))).status).toBe(201);
    expect(mockAppAuth).not.toHaveBeenCalled();
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({ registeredByAppDid: null }));
  });

  it.each([401, 403])('refuses invalid app credentials (%s) without creating an identity', async (status) => {
    mockAppAuth.mockResolvedValue({ error: 'Invalid app credential', status });
    const request = makeRequest(VALID_BODY);
    request.headers.set('Authorization', 'Bearer invalid');
    expect((await POST(request)).status).toBe(status);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it.each([
    ['Bearer opaque-session-token', null, 401],
    ['Bearer invalid-app-token', null, 401],
    ['Basic session-token', null, 401],
    ['', null, 401],
    ['Bearer delegated-app-token', { azp: 'did:imajin:app', isServiceToken: false }, 403],
  ] as const)('fails closed for Authorization %s', async (authorization, claims, status) => {
    const { authenticatePayApp } = await vi.importActual<typeof import('@/src/lib/kernel/app-service-auth')>(
      '@/src/lib/kernel/app-service-auth',
    );
    mockAppAuth.mockImplementationOnce(authenticatePayApp);
    mockVerifyAppToken.mockResolvedValueOnce(claims);
    const request = makeRequest(VALID_BODY);
    request.headers.set('Authorization', authorization);
    const response = await POST(request);
    expect(response.status).toBe(status);
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(mockCreateSessionToken).not.toHaveBeenCalled();
    expect(mockVerifyRegistrationSignature).not.toHaveBeenCalled();
  });
  it('documents optional app-service auth and fail-closed Authorization statuses', () => {
    const spec = parse(readFileSync(new URL('../../../../../api-spec/auth.yaml', import.meta.url), 'utf8'));
    const registration = spec.paths['/api/register'].post;
    expect(registration.security).toEqual([{}, { appServiceAuth: [] }]);
    expect(registration.description).toContain('session bearers and malformed Authorization return 401');
    expect(registration.description).toContain('permission return 403');
    expect(registration.responses['401'].description).toContain('no fallback');
    expect(registration.responses['403'].description).toContain('no fallback');
  });

  it('does not claim an existing signed identity on re-registration', async () => {
    mockDbSelect.mockImplementationOnce(() => selectChain([IDENTITY]));
    const request = makeRequest(VALID_BODY);
    request.headers.set('Authorization', 'Bearer fixture-app-token');
    expect((await POST(request)).status).toBe(200);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });
  it('uses the shared session writer on login-via-register', async () => {
    mockDbSelect.mockImplementationOnce(() => selectChain([IDENTITY]));
    const response = await POST(makeRequest(VALID_BODY));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: false });
    expect(response.headers.get('set-cookie')).toContain('session=mock-token');
  });

  it('uses the shared session writer after auto-accepting an invite', async () => {
    mockResolveInviteCode.mockResolvedValueOnce({ ok: true, inviteData: { id: 'FAKE_INVITE' } } as never);
    mockAutoAcceptInvite.mockResolvedValueOnce({ ok: true } as never);
    mockDbInsert.mockImplementationOnce(() => insertChain([IDENTITY]));
    const response = await POST(makeRequest(VALID_BODY));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ inviteAccepted: true });
    expect(response.headers.get('set-cookie')).toContain('session=mock-token');
  });
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
