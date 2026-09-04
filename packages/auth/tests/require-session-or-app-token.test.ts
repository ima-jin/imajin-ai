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

const AUTH_SERVICE_URL = 'https://auth.kernel.test/auth';
const APP_HOST = 'coffee.imajin.ai';
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
  process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
});

describe('requireSessionOrAppToken — token path (#1069 Phase 1)', () => {
  it('authenticates via a valid app token, scoped by aud', async () => {
    mocks.verifyAppTokenMock.mockResolvedValue({ sub: 'did:imajin:user', aud: APP_HOST, scopes: ['profile:read'] });

    const result = await requireSessionOrAppToken(bearerRequest('good-token'), { aud: APP_HOST });

    expect(result).toEqual({ auth: { did: 'did:imajin:user', scopes: ['profile:read'], via: 'token' } });
    expect(mocks.verifyAppTokenMock).toHaveBeenCalledWith('good-token', { aud: APP_HOST });
  });

  it('rejects with 403 when a required scope is missing', async () => {
    mocks.verifyAppTokenMock.mockResolvedValue({ sub: 'did:imajin:user', aud: APP_HOST, scopes: ['profile:read'] });

    const result = await requireSessionOrAppToken(bearerRequest('good-token'), {
      aud: APP_HOST,
      requireScopes: ['profile:read', 'connections:read'],
    });

    expect(result).toEqual({ error: 'Missing required scope(s): connections:read', status: 403 });
  });

  it('succeeds when all required scopes are present', async () => {
    mocks.verifyAppTokenMock.mockResolvedValue({
      sub: 'did:imajin:user',
      aud: APP_HOST,
      scopes: ['profile:read', 'connections:read'],
    });

    const result = await requireSessionOrAppToken(bearerRequest('good-token'), {
      aud: APP_HOST,
      requireScopes: ['profile:read'],
    });

    expect('auth' in result).toBe(true);
  });
});

describe('requireSessionOrAppToken — cookie fallback (#1069 Phase 1)', () => {
  it('falls back to the session cookie when there is no Authorization header', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ did: 'did:imajin:cookie-user' }), { status: 200 })) as unknown as typeof fetch;

    const result = await requireSessionOrAppToken(cookieRequest(`${SESSION_COOKIE_NAME}=cookie-value`), { aud: APP_HOST });

    expect(result).toEqual({ auth: { did: 'did:imajin:cookie-user', scopes: [], via: 'cookie' } });
    expect(mocks.verifyAppTokenMock).not.toHaveBeenCalled();
  });

  it('falls back to the cookie when the bearer does not verify as an app token', async () => {
    mocks.verifyAppTokenMock.mockResolvedValue(null);
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ did: 'did:imajin:cookie-user' }), { status: 200 })) as unknown as typeof fetch;

    const request = new Request('https://coffee.imajin.ai/api/pages/mine', {
      headers: {
        authorization: 'Bearer not-an-app-token',
        cookie: `${SESSION_COOKIE_NAME}=cookie-value`,
      },
    });

    const result = await requireSessionOrAppToken(request, { aud: APP_HOST });

    expect(result).toEqual({ auth: { did: 'did:imajin:cookie-user', scopes: [], via: 'cookie' } });
  });

  it('rejects with 401 when the cookie is invalid', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid' }), { status: 401 })) as unknown as typeof fetch;

    const result = await requireSessionOrAppToken(cookieRequest(`${SESSION_COOKIE_NAME}=bad-value`), { aud: APP_HOST });

    expect(result).toEqual({ error: 'Invalid or expired session', status: 401 });
  });
});

describe('requireSessionOrAppToken — neither credential present (#1069 Phase 1)', () => {
  it('rejects with 401 when there is no Authorization header and no session cookie', async () => {
    const result = await requireSessionOrAppToken(new Request('https://coffee.imajin.ai/api/pages/mine'), { aud: APP_HOST });

    expect(result).toEqual({
      error: 'Authorization: Bearer <app-token>, or a valid session cookie, is required',
      status: 401,
    });
  });
});
