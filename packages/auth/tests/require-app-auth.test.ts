/**
 * Tests for `requireAppAuth`'s bearer path, focused on the `notAppToken`
 * discriminator introduced for #1812.
 *
 * `resolveEffectiveDid` needs to tell apart two very different reasons the
 * bearer path can fail:
 *   - the bearer simply isn't an app token (bad signature/shape or expired)
 *     -> the caller should try session auth instead, since session JWTs are
 *     also sent as `Authorization: Bearer`.
 *   - the bearer IS an app token but is missing the required scope, or the
 *     auth service is unavailable -> the caller should surface that error
 *     as-is, never silently falling back to session auth.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

import { requireAppAuth } from '../src/require-app-auth';
import { setVaultInternalApiKey } from './support/internal-post-test-env';

const AUTH_SERVICE_URL = 'https://auth.kernel.test/auth';

function bearerRequest(token = 'some-bearer-token'): Request {
  return new Request('https://kernel.test/connections/api/connections', {
    headers: { authorization: `Bearer ${token}` },
  });

}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
});
afterEach(() => {
  setVaultInternalApiKey(undefined);
  vi.unstubAllGlobals();
});

describe('requireAppAuth — live act-as selector (#3202)', () => {
  const member = 'did:imajin:member';
  const org = 'did:imajin:org';
  const appAuth = { appDid: 'did:imajin:app', userDid: member, scopes: ['infer:completions'], attestationId: 'att_1' };
  function request() {
    return new Request('https://kernel.test/infer/v1/messages', {
      headers: { authorization: 'Bearer test-token', 'x-acting-as': org },
    });
  }
  function transport(membership: () => unknown, auth = appAuth) {
    setVaultInternalApiKey(randomUUID());
    const fetchMock = vi.fn(async (url: string) => Response.json(
      url.endsWith('/api/apps/token/verify') ? auth : membership(),
    ));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  it.each(['owner', 'admin', 'maintainer', 'agent'])('verifies the selector with the authenticated member, including %s role', async role => {
    const fetchMock = transport(() => ({ valid: true, role }));
    expect(await requireAppAuth(request(), { scope: 'infer:completions' })).toEqual({
      appAuth: { ...appAuth, actingAs: org },
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${AUTH_SERVICE_URL}/api/apps/token/verify`,
      `${AUTH_SERVICE_URL}/api/groups/${encodeURIComponent(org)}/controllers/${encodeURIComponent(member)}`,
    ]);
  });
  it.each([{ allowedServices: [] }, { allowedServices: ['pay'] }])('refuses an inference selector excluded by allowed_services %j', async ({ allowedServices }) => {
    transport(() => ({ valid: true, role: 'agent', allowedServices }));
    expect(await requireAppAuth(request(), { scope: 'infer:completions', service: 'infer' }))
      .toEqual({ error: 'Not authorized to act as this group', status: 403 });
  });
  it('accepts a selector restricted to the current service', async () => {
    transport(() => ({ valid: true, role: 'agent', allowedServices: ['infer'] }));
    expect(await requireAppAuth(request(), { scope: 'infer:completions', service: 'infer' }))
      .toHaveProperty('appAuth.actingAs', org);
  });
  it('verifies onBehalfOf rather than trusting x-acting-for', async () => {
    transport(() => ({ valid: true, role: 'agent' }));
    const req = request();
    req.headers.delete('x-acting-as');
    req.headers.set('x-acting-for', member);
    expect(await requireAppAuth(req, { service: 'infer' })).toHaveProperty('appAuth.actingFor', member);
  });
  it('rejects an unassigned onBehalfOf selector and an excluded delegation service', async () => {
    transport(() => ({ valid: true, role: 'agent', allowedServices: ['pay'] }));
    const req = request();
    req.headers.delete('x-acting-as');
    req.headers.set('x-acting-for', member);
    expect(await requireAppAuth(req, { service: 'infer' }))
      .toEqual({ error: 'Not authorized to act for this identity', status: 403 });
  });
  it('allows ordinary member selection only for explicitly grant-gated connector routes', async () => {
    transport(() => ({ valid: true, role: 'member' }));
    expect(await requireAppAuth(request(), { service: 'infer' })).toHaveProperty('status', 403);
    expect(await requireAppAuth(request(), { service: 'infer', allowMemberActAs: true }))
      .toHaveProperty('appAuth.actingAs', org);
  });
  it('revalidates the same token on the very next call after authority removal', async () => {
    let valid = true;
    const fetchMock = transport(() => ({ valid, role: 'agent' }));
    expect(await requireAppAuth(request())).toHaveProperty('appAuth.actingAs', org);
    valid = false;
    expect(await requireAppAuth(request())).toEqual({ error: 'Not authorized to act as this group', status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it.each([
    { valid: false, role: 'owner' },
    { valid: true, role: 'member' },
    { valid: true, role: 'agent', allowedServices: [] },
  ])('denies rejected or insufficient authority: %j', async membership => {
    transport(() => membership);
    expect(await requireAppAuth(request())).toEqual({ error: 'Not authorized to act as this group', status: 403 });
  });
  it('fails closed when the authority service fails', async () => {
    transport(() => { throw new Error('unavailable'); });
    expect(await requireAppAuth(request())).toEqual({ error: 'Not authorized to act as this group', status: 403 });
  });
  it('does not let a service token choose a member through a header', async () => {
    const fetchMock = transport(() => ({ valid: true, role: 'owner' }), { ...appAuth, userDid: '' });
    const req = request();
    req.headers.set('x-acting-for', member);
    expect(await requireAppAuth(req)).toEqual({ error: 'Not authorized to act as this group', status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('requireAppAuth — bearer path notAppToken discrimination (#1812)', () => {
  it.each(['app+jwt', 'app-service+jwt'])('never classifies a rejected %s as a session-token candidate', async typ => {
    const header = Buffer.from(JSON.stringify({ typ })).toString('base64url');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Invalid app token' }, { status: 401 })));
    expect(await requireAppAuth(bearerRequest(`${header}.fixture.invalid`))).toEqual({
      error: 'Invalid app token', status: 401, notAppToken: false,
    });
  });
  it('marks a 401 (invalid/expired token) response as notAppToken', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Invalid or expired app token' }), { status: 401 }),
    ) as unknown as typeof fetch;

    const result = await requireAppAuth(bearerRequest(), { scope: 'connections:read' });

    expect(result).toEqual({ error: 'Invalid or expired app token', status: 401, notAppToken: true });
  });

  it('does not mark a 403 (valid app token, missing scope) response as notAppToken', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Scope 'connections:read' was not granted" }), { status: 403 }),
    ) as unknown as typeof fetch;

    const result = await requireAppAuth(bearerRequest(), { scope: 'connections:read' });

    expect(result).toEqual({ error: "Scope 'connections:read' was not granted", status: 403, notAppToken: false });
  });

  it('does not mark an auth-service outage (503) as notAppToken', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await requireAppAuth(bearerRequest(), { scope: 'connections:read' });

    expect(result).toEqual({ error: 'Auth service unavailable', status: 503 });
  });

  it('resolves the app auth context on a successful verify', async () => {
    const appAuth = { appDid: 'did:imajin:app', userDid: 'did:imajin:user', scopes: ['connections:read'], attestationId: 'att_1' };
    global.fetch = vi.fn(async () => new Response(JSON.stringify(appAuth), { status: 200 })) as unknown as typeof fetch;

    const result = await requireAppAuth(bearerRequest(), { scope: 'connections:read' });

    expect(result).toEqual({ appAuth });
  });
});

describe('requireAppAuth — legacy X-App-* path vault key (#2353 step 4)', () => {
  function legacyRequest(): Request {
    return new Request('https://kernel.test/x/api/y', {
      headers: { 'x-app-did': 'did:imajin:app', 'x-app-authorization': 'att_1' },
    });
  }

  it('fails closed (503) when the vault key is missing, even if ATTESTATION_INTERNAL_API_KEY is hand-set', async () => {
    setVaultInternalApiKey(undefined);
    process.env.ATTESTATION_INTERNAL_API_KEY = 'env-value-must-be-ignored';
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await requireAppAuth(legacyRequest(), { scope: 'connections:read' });

      expect(result).toEqual({ error: 'Auth service misconfigured', status: 503 });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.ATTESTATION_INTERNAL_API_KEY;
    }
  });

  it('authenticates /api/apps/validate with the vault-sourced key', async () => {
    setVaultInternalApiKey('vault-sourced-key');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 403 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      await requireAppAuth(legacyRequest(), { scope: 'connections:read' });

      const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer vault-sourced-key');
    } finally {
      setVaultInternalApiKey(undefined);
    }
  });
});
