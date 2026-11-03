import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE_NAME } from '@imajin/config';

const state = vi.hoisted(() => ({ rows: [] as unknown[][], select: vi.fn() }));
vi.mock('@/src/db', () => ({
  db: { select: state.select },
  identities: {}, identityChains: {}, credentials: {},
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));
const person = {
  id: 'did:imajin:test', scope: 'actor', subtype: 'human', name: 'Database name',
  handle: 'database-handle', tier: 'established', metadata: { role: 'operator' },
};
const registryKey = Symbol.for('@imajin/auth/session-resolver/v1');

beforeEach(() => {
  vi.resetModules();
  Reflect.deleteProperty(globalThis, registryKey);
  const { privateKey } = generateKeyPairSync('ed25519');
  vi.stubEnv('AUTH_PRIVATE_KEY', privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'));
  vi.stubEnv('AUTH_SERVICE_URL', 'http://localhost:7000/auth');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected self-fetch'); }));
  state.rows = [[person], [{ did: person.id }], [{ value: 'test@example.test' }]];
  state.select.mockReset().mockImplementation(() => {
    const chain = {
      from: () => chain, where: () => chain,
      limit: async () => state.rows.shift() ?? [],
    };
    return chain;
  });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, registryKey);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function token() {
  const { createSessionToken } = await import('../jwt');
  return createSessionToken({ sub: person.id, scope: 'actor', handle: 'jwt-handle', name: 'JWT name' });
}
async function authenticated(sessionToken: string) {
  const { registerKernelSessionResolver } = await import('../session-resolver');
  const { requireAuth } = await import('@imajin/auth');
  registerKernelSessionResolver();
  return requireAuth(new Request('http://kernel.test/private', {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
  }));
}

describe('canonical kernel session resolver', () => {
  it('shares the route data and preserves exactly the old requireAuth Identity projection', async () => {
    const sessionToken = await token();
    const { resolveKernelSession } = await import('../session-resolver');
    expect(await resolveKernelSession(sessionToken)).toEqual({ data: {
      did: person.id, scope: 'actor', subtype: 'human', name: person.name,
      handle: person.handle, tier: 'established', email: 'test@example.test',
      role: 'operator', chainVerified: true,
    } });
    state.rows = [[person], [], []];
    expect(await authenticated(sessionToken)).toEqual({ identity: {
      id: person.id, scope: 'actor', subtype: 'human', name: person.name,
      handle: person.handle, tier: 'established',
    } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains JWT name/handle fallbacks and soft tier when the database fields are absent', async () => {
    state.rows = [[{ ...person, name: null, handle: null, scope: null, subtype: null, tier: null, metadata: null }], [], []];
    const { resolveKernelSession } = await import('../session-resolver');
    expect(await resolveKernelSession(await token())).toMatchObject({ data: {
      name: 'JWT name', handle: 'jwt-handle', scope: 'actor', tier: 'soft',
      role: 'member', email: null, chainVerified: false,
    } });
  });

  it('returns 401 for a correctly signed but expired session without a database lookup', async () => {
    const key = await importPKCS8(
      `-----BEGIN PRIVATE KEY-----\n${Buffer.from(process.env.AUTH_PRIVATE_KEY!, 'hex').toString('base64')}\n-----END PRIVATE KEY-----`,
      'EdDSA',
    );
    const expired = await new SignJWT({ scope: 'actor' }).setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(person.id).setIssuer('auth.imajin.ai').setExpirationTime(1).sign(key);
    expect(await authenticated(expired)).toEqual({ error: 'Invalid or expired session', status: 401 });
    expect(state.select).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['malformed', 'wrong-signature'])('returns 401 for %s sessions', async (kind) => {
    const sessionToken = kind === 'malformed' ? 'not-a-jwt' : `${(await token()).split('.').slice(0, 2).join('.')}.AAAA`;
    expect(await authenticated(sessionToken)).toEqual({ error: 'Invalid or expired session', status: 401 });
    expect(state.select).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns 401 for a removed/missing identity, never trusting only the JWT claims', async () => {
    state.rows = [[]];
    expect(await authenticated(await token())).toEqual({ error: 'Invalid or expired session', status: 401 });
    expect(state.select).toHaveBeenCalledTimes(1);
  });

  it('returns 503 for a database failure without falling back to loopback', async () => {
    state.select.mockImplementation(() => { throw new Error('database unavailable'); });
    expect(await authenticated(await token())).toEqual({ error: 'Auth service unavailable', status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
