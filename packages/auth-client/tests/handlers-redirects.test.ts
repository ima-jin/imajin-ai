import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createCallbackHandler, createLogoutHandler, type ImajinAuthConfig } from '../src/handlers';
import { sessionCookieName, verifySessionToken } from '../src/session';
import { forwardAuthCallback } from '../src/middleware';

const origin = 'https://jin.imajin.ai';
const query = '?attestation_id=att_123&user_did=did:imajin:alice';
const profile = { did: 'did:imajin:alice', displayName: 'Alice', handle: 'alice' };
const baseConfig: ImajinAuthConfig = { authUrl: origin, appDid: 'did:imajin:coffee', secret: 'test-secret-not-a-production-credential' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(profile)));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each([
  { name: 'without basePath', publicUrl: origin, basePath: '', nextBasePath: '' },
  { name: 'public URL basePath', publicUrl: `${origin}/coffee`, basePath: '/coffee', nextBasePath: '' },
  { name: 'trailing public URL slash', publicUrl: `${origin}/coffee/`, basePath: '/coffee', nextBasePath: '' },
  { name: 'Next.js basePath', publicUrl: origin, basePath: '/coffee', nextBasePath: '/coffee' },
  { name: 'both sources', publicUrl: `${origin}/coffee`, basePath: '/coffee', nextBasePath: '/coffee' },
  { name: 'request origin fallback', publicUrl: undefined, basePath: '', nextBasePath: '' },
  { name: 'Next.js basePath without public URL', publicUrl: undefined, basePath: '/coffee', nextBasePath: '/coffee' },
])('$name redirect destinations', ({ publicUrl, basePath, nextBasePath }) => {
  const config = { ...baseConfig, publicUrl };
  function request(search = query): NextRequest {
    return new NextRequest(`${origin}${basePath}/api/auth/callback${search}`, {
      nextConfig: { basePath: nextBasePath },
    });
  }

  it('callback success returns to the app root and creates a verifiable session', async () => {
    const response = await createCallbackHandler(config)(request());
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${origin}${basePath}/`);
    const cookie = response.cookies.get(sessionCookieName(config));
    expect(cookie?.value).toBeTruthy();
    expect(await verifySessionToken(cookie!.value, config)).toMatchObject({ ...profile, attestationId: 'att_123' });
  });

  it.each(['', '?attestation_id=att_123', '?user_did=did:imajin:alice'])(
    'missing_params returns to the app root: %s',
    async (search) => {
      const response = await createCallbackHandler(config)(request(search));
      expect(response.headers.get('location')).toBe(`${origin}${basePath}/?auth_error=missing_params`);
      expect(fetch).not.toHaveBeenCalled();
      expect(response.cookies.get(sessionCookieName(config))).toBeUndefined();
    },
  );

  it.each([
    { status: 403, error: 'attestation_revoked' },
    { status: 500, error: 'profile_fetch_failed' },
  ])('$error returns to the app root', async ({ status, error }) => {
    vi.mocked(fetch).mockResolvedValue(new Response('unavailable', { status }));
    const response = await createCallbackHandler(config)(request());
    expect(response.headers.get('location')).toBe(`${origin}${basePath}/?auth_error=${error}`);
    expect(response.cookies.get(sessionCookieName(config))).toBeUndefined();
  });

  it('network_error returns to the app root', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const response = await createCallbackHandler(config)(request());
    expect(response.headers.get('location')).toBe(`${origin}${basePath}/?auth_error=network_error`);
    expect(response.cookies.get(sessionCookieName(config))).toBeUndefined();
  });

  it('logout returns to the app root and clears the cookie', async () => {
    const response = await createLogoutHandler(config)(request());
    expect(response.headers.get('location')).toBe(`${origin}${basePath}/`);
    expect(response.cookies.get(sessionCookieName(config))).toMatchObject({ value: '', maxAge: 0 });
  });

  it.each(['/dashboard', '/dashboard?from=login#top', 'dashboard'])(
    'preserves basePath on custom login/logout destination %s',
    async (path) => {
      const custom = { ...config, loginRedirect: path, logoutRedirect: path };
      const expectedPath = path.startsWith('/') ? path : `/${path}`;
      expect((await createCallbackHandler(custom)(request())).headers.get('location'))
        .toBe(`${origin}${basePath}${expectedPath}`);
      expect((await createLogoutHandler(custom)(request())).headers.get('location'))
        .toBe(`${origin}${basePath}${expectedPath}`);
    },
  );

  it('does not double an already-prefixed basePath', async () => {
    const custom = { ...config, loginRedirect: `${basePath}/dashboard`, logoutRedirect: `${basePath}/` };
    expect((await createCallbackHandler(custom)(request())).headers.get('location')).toBe(`${origin}${basePath}/dashboard`);
    expect((await createLogoutHandler(custom)(request())).headers.get('location')).toBe(`${origin}${basePath}/`);
  });

  it('keeps absolute login/logout URLs unchanged', async () => {
    const destination = 'https://elsewhere.example/welcome?from=app#top';
    const custom = { ...config, loginRedirect: destination, logoutRedirect: destination };
    expect((await createCallbackHandler(custom)(request())).headers.get('location')).toBe(destination);
    expect((await createLogoutHandler(custom)(request())).headers.get('location')).toBe(destination);
  });
});

describe('public origin and path boundaries', () => {
  it('hands the root callback to the handler and lands signed in under the app basePath', async () => {
    const config = { ...baseConfig, publicUrl: `${origin}/coffee` };
    const rootRequest = new NextRequest(`${config.publicUrl}${query}`, { nextConfig: { basePath: '/coffee' } });
    const forwarded = forwardAuthCallback(rootRequest, config);
    expect(forwarded?.status).toBe(307);
    const callbackRequest = new NextRequest(forwarded!.headers.get('location')!, {
      nextConfig: { basePath: '/coffee' },
    });
    const response = await createCallbackHandler(config)(callbackRequest);
    expect(response.headers.get('location')).toBe(`${origin}/coffee/`);
    expect(await verifySessionToken(response.cookies.get(sessionCookieName(config))!.value, config))
      .toMatchObject({ did: profile.did, attestationId: 'att_123' });
  });
  it('shares forwarded origin resolution between handlers and middleware', async () => {
    const req = new NextRequest(`http://localhost:3000/coffee/api/auth/callback${query}`, {
      nextConfig: { basePath: '/coffee' },
      headers: { 'x-forwarded-host': 'dev-jin.imajin.ai', 'x-forwarded-proto': 'https' },
    });
    expect((await createCallbackHandler(baseConfig)(req)).headers.get('location')).toBe('https://dev-jin.imajin.ai/coffee/');
    expect((await createLogoutHandler(baseConfig)(req)).headers.get('location')).toBe('https://dev-jin.imajin.ai/coffee/');
  });

  it('prefers configured public URL over internal and forwarded origins', async () => {
    const req = new NextRequest(`http://localhost:3000/coffee/api/auth/callback${query}`, {
      headers: { 'x-forwarded-host': 'other.example', 'x-forwarded-proto': 'http' },
    });
    const config = { ...baseConfig, publicUrl: `${origin}/coffee` };
    expect((await createCallbackHandler(config)(req)).headers.get('location')).toBe(`${origin}/coffee/`);
  });

  it.each(['/coffeehouse', '/coffee'])('only treats a complete path segment as the prefix: %s', async (path) => {
    const config = { ...baseConfig, publicUrl: `${origin}/coffee`, logoutRedirect: path };
    const expected = path === '/coffee' ? '/coffee' : '/coffee/coffeehouse';
    expect((await createLogoutHandler(config)(new NextRequest(origin))).headers.get('location')).toBe(`${origin}${expected}`);
  });

  it('retains protocol-relative redirect behavior', async () => {
    const config = { ...baseConfig, publicUrl: `${origin}/coffee`, logoutRedirect: '//elsewhere.example/welcome' };
    expect((await createLogoutHandler(config)(new NextRequest(origin))).headers.get('location'))
      .toBe('https://elsewhere.example/welcome');
  });
});
