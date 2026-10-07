/**
 * Tests for `requireSessionOrAppToken` (#1069 Phase 1) — the adapter apps
 * adopt to accept either a scoped app token or the legacy shared session
 * cookie, so migration off the cookie can happen one call site at a time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({ verifyAppTokenMock: vi.fn() }));
vi.mock('../src/app-token', () => ({ verifyAppToken: mocks.verifyAppTokenMock }));

import { requireSessionOrAppToken } from '../src/require-session-or-app-token';
import { APP_AUD_ENV } from '../src/app-audience';

const AUTH_SERVICE_URL = 'https://auth.kernel.test/auth';
const APP_SLUG = 'coffee';
const SESSION_COOKIE_NAME = process.env.NODE_ENV === 'development' ? 'imajin_session_dev' : 'imajin_session';

function bearerRequest(token: string): Request {
  return new Request('https://coffee.imajin.ai/api/pages/mine', {
    headers: { authorization: `Bearer ${token}` },
  });
}

function cookieRequest(cookieHeader: string): Request {
  return new Request('https://coffee.imajin.ai/api/pages/mine', {
    headers: { cookie: cookieHeader },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env[APP_AUD_ENV];
  process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
});

describe('requireSessionOrAppToken — token path (#1069 Phase 1)', () => {
  it('authenticates via a valid app token, scoped by aud', async () => {
    mocks.verifyAppTokenMock.mockResolvedValue({ sub: 'did:imajin:user', slug: APP_SLUG, scopes: ['profile:read'] });

    const result = await requireSessionOrAppToken(bearerRequest('good-token'), { slug: APP_SLUG });

    expect(result).toEqual({ auth: { did: 'did:imajin:user', scopes: ['profile:read'], via: 'token' } });
    expect(mocks.verifyAppTokenMock).toHaveBeenCalledWith('good-token', { aud: APP_SLUG });
  });

  it('rejects with 403 when a required scope is missing', async () => {
    mocks.verifyAppTokenMock.mockResolvedValue({ sub: 'did:imajin:user', slug: APP_SLUG, scopes: ['profile:read'] });

    const result = await requireSessionOrAppToken(bearerRequest('good-token'), {
      slug: APP_SLUG,
      requireScopes: ['profile:read', 'connections:read'],
    });

    expect(result).toEqual({ error: 'Missing required scope(s): connections:read', status: 403 });
  });

  it('succeeds when all required scopes are present', async () => {
    mocks.verifyAppTokenMock.mockResolvedValue({
      sub: 'did:imajin:user',
      slug: APP_SLUG,
      scopes: ['profile:read', 'connections:read'],
    });

    const result = await requireSessionOrAppToken(bearerRequest('good-token'), {
      slug: APP_SLUG,
      requireScopes: ['profile:read'],
    });

    expect('auth' in result).toBe(true);
  });
});

describe('requireSessionOrAppToken — act-as (#2639 / #2644)', () => {
  const GROUP_DID = 'did:imajin:group-xyz';

  it('surfaces the verified actingAs claim on the token path', async () => {
    mocks.verifyAppTokenMock.mockResolvedValue({
      sub: 'did:imajin:user',
      slug: APP_SLUG,
      scopes: ['profile:read'],
      actingAs: GROUP_DID,
    });

    const result = await requireSessionOrAppToken(bearerRequest('good-token'), { slug: APP_SLUG });

    expect(result).toEqual({
      auth: { did: 'did:imajin:user', scopes: ['profile:read'], via: 'token', actingAs: GROUP_DID },
    });
  });

  it('leaves actingAs unset when the token carries no act-as claim', async () => {
    mocks.verifyAppTokenMock.mockResolvedValue({ sub: 'did:imajin:user', slug: APP_SLUG, scopes: [] });

    const result = await requireSessionOrAppToken(bearerRequest('good-token'), { slug: APP_SLUG });

    expect('auth' in result && 'actingAs' in result.auth).toBe(false);
  });

  it('does not let a caller-supplied x-acting-as header grant actingAs on the token path', async () => {
    mocks.verifyAppTokenMock.mockResolvedValue({ sub: 'did:imajin:user', slug: APP_SLUG, scopes: [] });
    const request = new Request('https://market.imajin.ai/api/me', {
      headers: { authorization: 'Bearer good-token', 'x-acting-as': GROUP_DID },
    });

    const result = await requireSessionOrAppToken(request, { slug: APP_SLUG });

    expect('auth' in result && 'actingAs' in result.auth).toBe(false);
  });

  it('leaves the cookie path as-is: x-acting-as is ignored and actingAs is never set', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ did: 'did:imajin:cookie-user' }), { status: 200 })) as unknown as typeof fetch;
    const request = new Request('https://market.imajin.ai/api/me', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=cookie-value`, 'x-acting-as': GROUP_DID },
    });

    const result = await requireSessionOrAppToken(request, { slug: APP_SLUG });

    expect(result).toEqual({ auth: { did: 'did:imajin:cookie-user', scopes: [], via: 'cookie' } });
  });
});

describe('requireSessionOrAppToken — cookie fallback (#1069 Phase 1)', () => {
  it('falls back to the session cookie when there is no Authorization header', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ did: 'did:imajin:cookie-user' }), { status: 200 })) as unknown as typeof fetch;

    const result = await requireSessionOrAppToken(cookieRequest(`${SESSION_COOKIE_NAME}=cookie-value`), { slug: APP_SLUG });

    expect(result).toEqual({ auth: { did: 'did:imajin:cookie-user', scopes: [], via: 'cookie' } });
    expect(mocks.verifyAppTokenMock).not.toHaveBeenCalled();
  });

  it('does NOT fall back to the cookie when a Bearer fails verification (#2706)', async () => {
    mocks.verifyAppTokenMock.mockResolvedValue(null);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ did: 'did:imajin:cookie-user' }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const request = new Request('https://coffee.imajin.ai/api/pages/mine', {
      headers: {
        authorization: 'Bearer wrong-aud-token',
        cookie: `${SESSION_COOKIE_NAME}=cookie-value`,
      },
    });

    const result = await requireSessionOrAppToken(request, { slug: APP_SLUG });

    expect(result).toEqual({ error: 'Invalid or expired app token for this app', status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the cookie is invalid', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid' }), { status: 401 })) as unknown as typeof fetch;

    const result = await requireSessionOrAppToken(cookieRequest(`${SESSION_COOKIE_NAME}=bad-value`), { slug: APP_SLUG });

    expect(result).toEqual({ error: 'Invalid or expired session', status: 401 });
  });
});

describe('requireSessionOrAppToken — neither credential present (#1069 Phase 1)', () => {
  it('rejects with 401 when there is no Authorization header and no session cookie', async () => {
    const result = await requireSessionOrAppToken(new Request('https://coffee.imajin.ai/api/pages/mine'), { slug: APP_SLUG });

    expect(result).toEqual({
      error: 'Authorization: Bearer <app-token>, or a valid session cookie, is required',
      status: 401,
    });
  });
});

describe('requireSessionOrAppToken — audience resolution (#2706)', () => {
  it('verifies against the slug by default (IMAJIN_APP_AUD unset)', async () => {
    mocks.verifyAppTokenMock.mockResolvedValue({ sub: 'did:imajin:user', aud: 'dykil', scopes: [] });

    await requireSessionOrAppToken(bearerRequest('t'), { slug: 'dykil' });

    expect(mocks.verifyAppTokenMock).toHaveBeenCalledWith('t', { aud: 'dykil' });
  });

  it('verifies against IMAJIN_APP_AUD when set', async () => {
    process.env[APP_AUD_ENV] = 'dykil-staging';
    mocks.verifyAppTokenMock.mockResolvedValue({ sub: 'did:imajin:user', aud: 'dykil-staging', scopes: [] });

    await requireSessionOrAppToken(bearerRequest('t'), { slug: 'dykil' });

    expect(mocks.verifyAppTokenMock).toHaveBeenCalledWith('t', { aud: 'dykil-staging' });
  });

  it('rejects a mismatched audience with 401 (no cookie fallback)', async () => {
    // The kernel answers null for a token whose aud does not match the expected one.
    mocks.verifyAppTokenMock.mockImplementation(async (_t: string, o: { aud: string }) =>
      o.aud === 'links' ? { sub: 'did:imajin:user', aud: 'links', scopes: [] } : null,
    );

    const result = await requireSessionOrAppToken(bearerRequest('links-token'), { slug: 'dykil' });

    expect(result).toEqual({ error: 'Invalid or expired app token for this app', status: 401 });
  });

  it('fails closed with 500 — never reaching the kernel — when the audience is a host', async () => {
    process.env[APP_AUD_ENV] = 'dev-jin.imajin.ai';

    const result = await requireSessionOrAppToken(bearerRequest('t'), { slug: 'dykil' });

    expect(result).toEqual({ error: 'App audience is misconfigured', status: 500 });
    expect(mocks.verifyAppTokenMock).not.toHaveBeenCalled();
  });

  it('does not resolve the audience for cookie-only callers', async () => {
    process.env[APP_AUD_ENV] = 'dev-jin.imajin.ai';
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ did: 'did:imajin:cookie-user' }), { status: 200 })) as unknown as typeof fetch;

    const result = await requireSessionOrAppToken(cookieRequest(`${SESSION_COOKIE_NAME}=v`), { slug: APP_SLUG });

    expect('auth' in result).toBe(true);
  });
});
