import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE_NAME } from '@imajin/config';
import { provideSessionResolver, resolveSessionData } from '../src/session-resolver';
import { requireAuth } from '../src/require-auth';
import { resolveActingDid } from '../src/acting-did';
import { setVaultInternalApiKey } from './support/internal-post-test-env';

const PERSON = 'did:imajin:person';
const ORG = 'did:imajin:org';
const data = { did: PERSON, scope: 'actor', subtype: 'human', name: 'Person', handle: 'person', tier: 'established' as const };
const key = Symbol.for('@imajin/auth/session-resolver/v1');
function clearResolver() { Reflect.deleteProperty(globalThis, key); }
function request(headers: Record<string, string> = {}) {
  return new Request('http://kernel.test/api/private', {
    headers: { cookie: `${SESSION_COOKIE_NAME}=test-session`, ...headers },
  });
}
beforeEach(() => {
  clearResolver();
  vi.stubEnv('AUTH_SERVICE_URL', 'http://localhost:7000/auth');
  vi.stubGlobal('fetch', vi.fn());
  setVaultInternalApiKey('test-only-internal-key');
});
afterEach(() => {
  clearResolver();
  setVaultInternalApiKey(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('kernel-injected session validation', () => {
  it('preserves the exact Identity shape without an HTTP call in personal context', async () => {
    provideSessionResolver(async () => data);
    const result = await requireAuth(request());
    expect(result).toEqual({ identity: {
      id: PERSON, scope: 'actor', subtype: 'human', name: 'Person', handle: 'person', tier: 'established',
    } });
    expect('identity' in result && resolveActingDid(result.identity)).toBe(PERSON);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('survives separate Next module bundles via the process-global registry', async () => {
    provideSessionResolver(async () => data);
    vi.resetModules();
    const separatelyBundled = await import('../src/session-resolver');
    expect(await separatelyBundled.resolveSessionData('test')).toEqual(data);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still verifies acting-as authority and uses the organization identity', async () => {
    provideSessionResolver(async () => data);
    vi.mocked(fetch).mockResolvedValue(Response.json({ valid: true, role: 'owner', allowedServices: ['jin'] }));
    const result = await requireAuth(request({ 'x-acting-as': ORG }), { service: 'jin' });
    expect(result).toMatchObject({ identity: { id: PERSON, actingAs: ORG, actingAsRole: 'owner' } });
    expect('identity' in result && resolveActingDid(result.identity)).toBe(ORG);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/controllers/');
  });

  it.each([
    { valid: false },
    { valid: true, role: 'member' },
    { valid: true, role: 'owner', allowedServices: ['pay'] },
  ])('fails closed for denied acting-as authority: %j', async (response) => {
    provideSessionResolver(async () => data);
    vi.mocked(fetch).mockResolvedValue(Response.json(response));
    expect(await requireAuth(request({ 'x-acting-as': ORG }), { service: 'jin' }))
      .toEqual({ error: 'Not authorized to act as this group', status: 403 });
  });

  it('does not use a resolver without a cookie or fall back to a supplied bearer for invalid cookies', async () => {
    const resolver = vi.fn(async () => null);
    provideSessionResolver(resolver);
    expect(await requireAuth(new Request('http://kernel.test/private'))).toMatchObject({ status: 401 });
    expect(resolver).not.toHaveBeenCalled();
    expect(await requireAuth(request({ authorization: 'Bearer ignored' })))
      .toEqual({ error: 'Invalid or expired session', status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns 503 on a resolver failure, never falls back to self-HTTP', async () => {
    provideSessionResolver(async () => { throw new Error('test database unavailable'); });
    expect(await requireAuth(request())).toEqual({ error: 'Auth service unavailable', status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an identity-less resolver result', async () => {
    provideSessionResolver(async () => ({}));
    expect(await requireAuth(request())).toEqual({ error: 'Invalid session data', status: 401 });
  });

  it('standalone corpus/broker consumers retain bounded HTTP and the same identity mapping', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json(data));
    expect(await resolveSessionData('test-session')).toEqual(data);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://localhost:7000/auth/api/session');
  });
});
