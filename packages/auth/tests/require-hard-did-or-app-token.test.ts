/**
 * Tests for `requireHardDIDOrAppToken` (#2640) — hard-DID gate that works for
 * both the legacy session cookie and scoped app tokens.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({ verifyAppTokenMock: vi.fn() }));
vi.mock('../src/app-token', () => ({ verifyAppToken: mocks.verifyAppTokenMock }));

import { requireHardDIDOrAppToken, clearTierCache } from '../src/require-hard-did-or-app-token';

const AUTH_SERVICE_URL = 'https://auth.kernel.test/auth';
const APP_HOST = 'market.imajin.ai';
const DID = 'did:imajin:buyer';
const SESSION_COOKIE_NAME = process.env.NODE_ENV === 'development' ? 'imajin_session_dev' : 'imajin_session';

const bearerRequest = () =>
  new Request('https://market.imajin.ai/api/listings/1/purchase', {
    headers: { authorization: 'Bearer good-token' },
  });
const cookieRequest = () =>
  new Request('https://market.imajin.ai/api/listings/1/purchase', {
    headers: { cookie: `${SESSION_COOKIE_NAME}=cookie-value` },
  });

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string) => handler(url));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.clearAllMocks();
  clearTierCache();
  process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
  mocks.verifyAppTokenMock.mockResolvedValue({ sub: DID, aud: APP_HOST, scopes: ['market:purchase'] });
});

describe('requireHardDIDOrAppToken — session (cookie) path', () => {
  it('succeeds for a hard DID', async () => {
    mockFetch(() => json({ did: DID, tier: 'preliminary' }));
    const result = await requireHardDIDOrAppToken(cookieRequest(), { aud: APP_HOST });
    expect(result).toEqual({ auth: { did: DID, scopes: [], via: 'cookie' } });
  });

  it('403s a soft DID', async () => {
    mockFetch(() => json({ did: DID, tier: 'soft' }));
    const result = await requireHardDIDOrAppToken(cookieRequest(), { aud: APP_HOST });
    expect(result).toEqual({ error: 'This action requires a full identity (hard DID)', status: 403 });
  });

  it('treats a session with no tier as soft', async () => {
    mockFetch(() => json({ did: DID }));
    const result = await requireHardDIDOrAppToken(cookieRequest(), { aud: APP_HOST });
    expect(result).toMatchObject({ status: 403 });
  });

  it('401s an invalid session', async () => {
    mockFetch(() => json({ error: 'invalid' }, 401));
    const result = await requireHardDIDOrAppToken(cookieRequest(), { aud: APP_HOST });
    expect(result).toEqual({ error: 'Invalid or expired session', status: 401 });
  });
});

describe('requireHardDIDOrAppToken — app token path', () => {
  it('succeeds for a hard DID, looking the tier up on the public identity endpoint', async () => {
    const fetchMock = mockFetch(() => json({ did: DID, tier: 'established' }));
    const result = await requireHardDIDOrAppToken(bearerRequest(), { aud: APP_HOST });
    expect(result).toEqual({ auth: { did: DID, scopes: ['market:purchase'], via: 'token' } });
    expect(fetchMock).toHaveBeenCalledWith(`${AUTH_SERVICE_URL}/api/identity/${encodeURIComponent(DID)}`, {
      cache: 'no-store',
    });
  });

  it('403s a soft DID', async () => {
    mockFetch(() => json({ did: DID, tier: 'soft' }));
    const result = await requireHardDIDOrAppToken(bearerRequest(), { aud: APP_HOST });
    expect(result).toEqual({ error: 'This action requires a full identity (hard DID)', status: 403 });
  });

  it('still enforces required scopes before any tier lookup', async () => {
    const fetchMock = mockFetch(() => json({ tier: 'preliminary' }));
    const result = await requireHardDIDOrAppToken(bearerRequest(), {
      aud: APP_HOST,
      requireScopes: ['market:admin'],
    });
    expect(result).toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed (503) when the tier cannot be determined', async () => {
    mockFetch(() => json({ error: 'boom' }, 500));
    expect(await requireHardDIDOrAppToken(bearerRequest(), { aud: APP_HOST })).toMatchObject({ status: 503 });

    mockFetch(() => json({ did: DID }));
    expect(await requireHardDIDOrAppToken(bearerRequest(), { aud: APP_HOST })).toMatchObject({ status: 503 });

    mockFetch(() => {
      throw new Error('network');
    });
    expect(await requireHardDIDOrAppToken(bearerRequest(), { aud: APP_HOST })).toMatchObject({ status: 503 });
  });

  it('caches successful tier lookups', async () => {
    const fetchMock = mockFetch(() => json({ did: DID, tier: 'preliminary' }));
    await requireHardDIDOrAppToken(bearerRequest(), { aud: APP_HOST });
    await requireHardDIDOrAppToken(bearerRequest(), { aud: APP_HOST });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache failed lookups', async () => {
    mockFetch(() => json({ error: 'boom' }, 500));
    await requireHardDIDOrAppToken(bearerRequest(), { aud: APP_HOST });
    const fetchMock = mockFetch(() => json({ did: DID, tier: 'preliminary' }));
    const result = await requireHardDIDOrAppToken(bearerRequest(), { aud: APP_HOST });
    expect('auth' in result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('requireHardDIDOrAppToken — no credentials', () => {
  it('401s', async () => {
    const result = await requireHardDIDOrAppToken(new Request('https://market.imajin.ai/x'), { aud: APP_HOST });
    expect(result).toMatchObject({ status: 401 });
  });
});
