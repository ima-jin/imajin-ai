import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server';
import { CookieJar } from 'tough-cookie';

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  verify: vi.fn(),
  signature: vi.fn(),
  publish: vi.fn(async () => undefined),
  emailMfa: vi.fn(() => true),
  chainIdentity: null as Record<string, unknown> | null,
  grace: vi.fn(async () => null),
  migrateTickets: vi.fn(async () => undefined),
}));
const identity = { id: 'did:imajin:FAKE_USER', publicKey: 'FAKE_PUBLIC_KEY', scope: 'actor', tier: 'preliminary', handle: 'fake' };

vi.mock('@/src/db', () => {
  function query() {
    const result = state.rows.shift() ?? [];
    const chain = {
      from: () => chain, where: () => chain, limit: async () => result,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
    };
    return chain;
  }
  return {
    db: {
      select: query,
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      insert: () => ({ values: () => ({
        returning: async () => [{ id: 'did:imajin:FAKE_USER', scope: 'actor', tier: 'preliminary' }],
        onConflictDoNothing: async () => undefined,
      }) }),
    },
    identities: {}, challenges: {}, mfaMethods: {}, identityChains: {}, credentials: {}, profiles: {}, onboardTokens: {},
  };
});
vi.mock('@/src/lib/auth/jwt', async () => {
  const { getSessionCookieOptions } = await import('@imajin/config');
  return {
    getSessionCookieOptions,
    createSessionToken: async () => 'FAKE_NEW_SESSION',
    verifySessionToken: state.verify,
    createMfaChallengeToken: async () => 'FAKE_MFA_CHALLENGE',
    verifyMfaChallengeToken: async () => ({ sub: 'did:imajin:FAKE_USER', methods: ['email'] }),
  };
});
vi.mock('@/src/lib/auth/crypto', () => ({
  verifySignature: state.signature,
  didFromPublicKey: () => 'did:imajin:FAKE_USER',
}));
vi.mock('@/src/lib/auth/emit-session-attestation', () => ({ emitSessionAttestation: async () => undefined }));
vi.mock('@/src/lib/auth/log-device', () => ({ logDevice: async () => undefined }));
vi.mock('@/src/lib/auth/dfos', () => ({
  getChainByImajinDid: async () => null,
  getIdentityByDfosDid: async () => state.chainIdentity,
  storeDfosChain: async () => true,
}));
vi.mock('@/src/lib/auth/chain-providers', () => ({
  verifyChainLog: async () => ({ valid: true, did: 'did:dfos:FAKE_CHAIN', publicKeyHex: 'FAKE_PUBLIC_KEY' }),
}));
vi.mock('@/src/lib/auth/onboard', () => ({
  addScopeMembership: async () => undefined,
  handleExpiredOrUsedToken: state.grace,
  resolveOnboardIdentity: async () => ({
    did: 'did:imajin:FAKE_USER', identity: { tier: 'preliminary' }, created: false, claimActivated: false,
  }),
  resolveOnboardRedirect: async () => 'https://jin.imajin.ai/events',
}));
vi.mock('@/src/lib/auth/consume-invite', () => ({ consumePendingInvites: async () => undefined }));
vi.mock('@/src/lib/auth/onboard-tickets', () => ({ migrateOnboardTickets: state.migrateTickets }));
vi.mock('@/src/lib/auth/encrypt', () => ({ decryptSecret: () => 'FAKE_UNUSED' }));
vi.mock('@/src/lib/auth/email-mfa-codes', () => ({ verifyEmailMfaCode: state.emailMfa }));
vi.mock('@imajin/bus', () => ({ publish: state.publish }));
vi.mock('@imajin/logger', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    createLogger: () => log,
    withLogger: (_name: string, handler: (req: NextRequest, context: { log: typeof log }) => unknown) =>
      (req: NextRequest) => handler(req, { log }),
  };
});

import { POST as login } from '../../../../app/auth/api/login/verify/route';
import { POST as mfa } from '../../../../app/auth/api/login/mfa/route';
import { POST as logout } from '../../../../app/auth/api/logout/route';
import { POST as connectionsLogout } from '../../../../app/connections/api/auth/logout/route';
import { POST as profileLogout } from '../../../../app/profile/api/auth/logout/route';
import { GET as session } from '../../../../app/auth/api/session/route';
import { POST as presentChain } from '../../../../app/auth/api/identity/present-chain/route';
import { POST as generate } from '../../../../app/auth/api/onboard/generate/route';
import { POST as claim } from '../../../../app/auth/api/onboard/claim/route';
import { GET as verifyOnboard } from '../../../../app/auth/api/onboard/verify/route';

beforeEach(() => {
  vi.stubEnv('IMAJIN_ENV', 'prod');
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('SESSION_COOKIE_SCOPE', '');
  vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'https://jin.imajin.ai/');
  vi.clearAllMocks();
  state.rows = [];
  state.verify.mockImplementation(async (token: string) =>
    token.startsWith('FAKE_') ? { sub: identity.id, scope: 'actor' } : null);
  state.signature.mockResolvedValue(true);
  state.chainIdentity = null;
  state.grace.mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function request(path: string, body?: unknown, cookie = '') {
  return new NextRequest(`https://jin.imajin.ai${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function expectMigrated(response: NextResponse) {
  const headers = response.headers.getSetCookie();
  expect(headers).toHaveLength(2);
  const active = headers.find(h => h.startsWith('imajin_session=FAKE_NEW_SESSION'))!;
  expect(active).toBeDefined();
  expect(active).not.toMatch(/domain=/i);
  expect(active).toContain('HttpOnly');
  expect(active).toContain('Secure');
  expect(active).toContain('SameSite=none');
  const expired = headers.find(h => h.includes('Domain=.imajin.ai'))!;
  expect(expired).toContain('Max-Age=0');
}

describe('kernel session routes — phase 2', () => {
  it.each(['known-chain', 'known-key', 'new-identity'])('migrates sessions from present-chain (%s)', async (branch) => {
    state.chainIdentity = branch === 'known-chain' ? { imajinDid: identity.id, scope: 'actor', tier: 'preliminary' } : null;
    state.rows = branch === 'known-key' ? [[identity]] : [[]];
    const response = await presentChain(request('/auth/api/identity/present-chain', { chainLog: ['FAKE_CHAIN_ENTRY'] }));
    expect(response.status).toBe(branch === 'new-identity' ? 201 : 200);
    expectMigrated(response);
  });

  it('onboard generate preserves the active forest cookie and migrates the session', async () => {
    state.rows = [[identity]];
    const response = await generate(request('/auth/api/onboard/generate', { publicKey: '0'.repeat(64), scopeDid: 'did:imajin:FAKE_GROUP' }));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toHaveLength(3);
    expect(response.headers.getSetCookie().filter(h => h.startsWith('imajin_session='))).toHaveLength(2);
    expect(response.headers.get('set-cookie')).toContain('x-acting-as=did%3Aimajin%3AFAKE_GROUP');
  });

  it('onboard claim preserves the active forest cookie and migrates the session', async () => {
    state.rows = [[{ id: 'FAKE_RECORD', usedAt: new Date(), email: 'fake@example.com', scopeDid: 'did:imajin:FAKE_GROUP' }], [{ did: identity.id }], [identity]];
    const response = await claim(request('/auth/api/onboard/claim', { handoffToken: 'FAKE_HANDOFF' }));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toHaveLength(3);
    expect(response.headers.getSetCookie().filter(h => h.startsWith('imajin_session='))).toHaveLength(2);
  });

  it('non-polling email verification preserves same-origin landing and both cookie headers', async () => {
    vi.stubEnv('APP_URL', 'https://jin.imajin.ai');
    state.rows = [[{ id: 'FAKE_RECORD', email: 'fake@example.com', scopeDid: 'did:imajin:FAKE_GROUP' }]];
    const response = await verifyOnboard(request('/auth/api/onboard/verify?token=FAKE_ONBOARD'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://jin.imajin.ai/events');
    expect(state.migrateTickets).toHaveBeenCalledWith('fake@example.com', identity.id);
    expect(response.headers.getSetCookie()).toHaveLength(3);
    expect(response.headers.getSetCookie().filter(h => h.startsWith('imajin_session='))).toHaveLength(2);
  });

  it('used-email fallback stays on the kernel root without depending on events', async () => {
    vi.stubEnv('APP_URL', 'https://dev-jin.imajin.ai');
    const response = await verifyOnboard(request('/auth/api/onboard/verify?token=FAKE_USED'));
    expect(response.status).toBe(410);
    expect(state.grace).toHaveBeenCalledWith('FAKE_USED', null, expect.anything(), 'https://dev-jin.imajin.ai');
  });
  it('login migrates an existing legacy session and preserves response data', async () => {
    state.rows = [[{ id: 'FAKE_CHALLENGE_ID', identityId: identity.id, challenge: 'FAKE_CHALLENGE' }], [identity], []];
    const response = await login(request('/auth/api/login/verify', { challengeId: 'FAKE_ID', signature: 'FAKE_SIGNATURE' }, 'imajin_session=FAKE_LEGACY'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ did: identity.id });
    expectMigrated(response);
    const jar = new CookieJar();
    const url = 'https://jin.imajin.ai/';
    await jar.setCookie('imajin_session=FAKE_LEGACY; Domain=.imajin.ai; Path=/', url);
    for (const header of response.headers.getSetCookie()) await jar.setCookie(header, url);
    expect(await jar.getCookies(url)).toMatchObject([{ value: 'FAKE_NEW_SESSION', hostOnly: true }]);
  });

  it('MFA completion also migrates the cookie', async () => {
    state.rows = [[identity]];
    const response = await mfa(request('/auth/api/login/mfa', { challengeToken: 'FAKE_CHALLENGE', method: 'email', code: 'FAKE_CODE' }));
    expect(response.status).toBe(200);
    expectMigrated(response);
  });

  it('does not issue or expire sessions on rejected login', async () => {
    const response = await login(request('/auth/api/login/verify', {}));
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it('a legacy-only session remains authenticated after deploy, without a write or forced logout', async () => {
    state.rows = [[identity], [], []];
    const response = await session(request('/auth/api/session', undefined, 'imajin_session=FAKE_LEGACY'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ did: identity.id });
    expect(state.verify).toHaveBeenCalledWith('FAKE_LEGACY');
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it.each(['invalid', 'missing-identity'])('clears both cookie scopes for %s sessions', async (reason) => {
    if (reason === 'invalid') state.verify.mockResolvedValue(null);
    const response = await session(request('/auth/api/session', undefined, 'imajin_session=FAKE_LEGACY'));
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(response.headers.getSetCookie().every(h => h.includes('Max-Age=0'))).toBe(true);
  });

  it.each([
    ['auth', logout],
    ['connections', connectionsLogout],
    ['profile', profileLogout],
  ])('%s logout removes both coexisting cookies and cannot leave a session behind', async (_name, handler) => {
    const url = 'https://jin.imajin.ai/';
    const jar = new CookieJar();
    await jar.setCookie('imajin_session=FAKE_LEGACY; Domain=.imajin.ai; Path=/', url);
    await jar.setCookie('imajin_session=FAKE_HOST; Path=/', url);
    const response = await handler(request('/auth/api/logout', {}, await jar.getCookieString(url)));
    expect(response.status).toBe(200);
    const headers = response.headers.getSetCookie();
    expect(headers).toHaveLength(2);
    expect(headers.every(h => h.includes('Max-Age=0'))).toBe(true);
    for (const header of headers) await jar.setCookie(header, url);
    expect(await jar.getCookieString(url)).toBe('');
    const afterLogout = await session(request('/auth/api/session', undefined, await jar.getCookieString(url)));
    expect(afterLogout.status).toBe(401);
  });
});
