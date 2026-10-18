import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveEffectiveDid } from '../src/resolve-effective-did';
import { requireAuth } from '../src/require-auth';
import { setVaultInternalApiKey } from './support/internal-post-test-env';

const PERSON = 'did:imajin:maintainer';
const ORG = 'did:imajin:business';
const AGENT = 'did:imajin:agent';
const REFUSAL = { ok: false, status: 403, error: 'Not authorized to act as this group' };
let allowedServices: unknown;
let role: string;
let grantAllowed: boolean;
let callerDid: string;
let fetchMock: ReturnType<typeof vi.fn>;

function request(method: string, overlay: 'header' | 'cookie' = 'header') {
  return new Request('https://kernel.test/api', {
    method,
    headers: {
      cookie: `imajin_session=test${overlay === 'cookie' ? `; x-acting-as=${ORG}` : ''}`,
      ...(overlay === 'header' ? { 'x-acting-as': ORG } : {}),
    },
  });
}

beforeEach(() => {
  vi.stubEnv('AUTH_SERVICE_URL', 'https://auth.test');
  vi.stubEnv('AUTH_INTERNAL_API_KEY', 'test-internal-key');
  setVaultInternalApiKey('test-vault-key');
  allowedServices = ['pay'];
  role = 'maintainer';
  grantAllowed = true;
  callerDid = PERSON;
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/api/session')) return Response.json({ did: callerDid, scope: 'actor' });
    if (url.includes('/controllers/')) return Response.json({ valid: true, role, allowedServices });
    if (url.endsWith('/verify-delegation')) return Response.json({ allowed: grantAllowed, via: grantAllowed ? 'grant' : 'none' });
    throw new Error(`Unexpected auth URL: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  setVaultInternalApiKey(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each(['GET', 'POST'])('effective DID service gate (%s)', (method) => {
  it.each(['header', 'cookie'] as const)('allows the listed service through %s act-as', async (overlay) => {
    const result = await resolveEffectiveDid(request(method, overlay), { scope: 'wallet:write', service: 'pay' });
    expect(result).toEqual({ ok: true, effectiveDid: ORG, via: 'session', composedBy: null });
  });

  it.each(['header', 'cookie'] as const)('refuses an unlisted service through %s act-as, never the personal DID', async (overlay) => {
    expect(await resolveEffectiveDid(request(method, overlay), {
      scope: 'connections:read', service: 'connections',
    })).toEqual(REFUSAL);
  });

  it.each(['owner', 'admin', 'maintainer', 'agent'])('leaves unrestricted %s controllers unchanged', async (controllerRole) => {
    allowedServices = null;
    role = controllerRole;
    expect(await resolveEffectiveDid(request(method), {
      scope: 'connections:write', service: 'connections',
    })).toMatchObject({ ok: true, effectiveDid: ORG });
  });

  it.each([{ services: [] }, { services: 'pay' }, { services: ['payment'] }])('fails closed for empty, malformed or nonmatching restrictions ($services)', async ({ services }) => {
    allowedServices = services;
    expect(await resolveEffectiveDid(request(method), { scope: 'wallet:write', service: 'pay' })).toEqual(REFUSAL);
  });

  it('refuses missing runtime service context before any authentication fallback', async () => {
    const options = { scope: 'wallet:write' } as Parameters<typeof resolveEffectiveDid>[1];
    expect(await resolveEffectiveDid(request(method), options)).toEqual(REFUSAL);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('refuses blank service context in the helper (%j)', async (service) => {
    expect(await resolveEffectiveDid(request(method), { scope: 'wallet:write', service })).toEqual(REFUSAL);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves legacy optional-service requireAuth compatibility outside helper callers', async () => {
    expect(await requireAuth(request(method))).toMatchObject({ identity: { id: PERSON, actingAs: ORG } });
  });

  it.each([true, false])('keeps agent delegation authoritative (grant allowed: %s)', async (allowed) => {
    callerDid = AGENT;
    grantAllowed = allowed;
    const delegated = new Request('https://kernel.test/connections/api', {
      method, headers: { cookie: 'imajin_session=test', 'x-acting-for': ORG },
    });
    const result = await resolveEffectiveDid(delegated, { scope: 'connections:read', service: 'connections' });
    expect(result).toEqual(allowed
      ? { ok: true, effectiveDid: ORG, via: 'session', composedBy: AGENT }
      : { ok: false, status: 403, error: 'Not authorized to act for this identity' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/controllers/'))).toBe(false);
  });

  it('enforces the service in the legacy agent membership fallback too', async () => {
    vi.stubEnv('AUTH_INTERNAL_API_KEY', '');
    callerDid = AGENT;
    role = 'agent';
    const delegated = new Request('https://kernel.test/connections/api', {
      method, headers: { cookie: 'imajin_session=test', 'x-acting-for': ORG },
    });
    expect(await resolveEffectiveDid(delegated, {
      scope: 'connections:read', service: 'connections',
    })).toEqual({ ok: false, status: 403, error: 'Not authorized to act for this identity' });
  });
});
