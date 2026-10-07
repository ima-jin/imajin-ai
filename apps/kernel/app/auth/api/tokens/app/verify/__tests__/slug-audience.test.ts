/**
 * Cross-app audience isolation (#2706), end to end through the real SDK and the
 * real kernel verify route: an app configured with its registry slug accepts
 * tokens minted for that slug and rejects tokens minted for any other app —
 * with no cookie fallback and no host audience involved anywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
}));
vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}), SESSION_COOKIE_NAME: 'imajin_session' }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

/** Registry as seeded/provisioned: audiences are slugs — the shared host is NOT registered. */
const REGISTERED_AUDIENCES = new Set(['dykil', 'links', 'coffee', 'jin']);
vi.mock('@/src/lib/kernel/app-registry', () => ({
  resolveActiveAppByAudience: async (aud: string) => (REGISTERED_AUDIENCES.has(aud) ? { id: `app_${aud}` } : null),
  appNotRegisteredResponse: () => new Response(JSON.stringify({ error: 'app_not_registered' }), { status: 403 }),
}));

import { requireSessionOrAppToken } from '@imajin/auth';
import { createSessionAppToken } from '@/src/lib/auth/jwt';
import { POST as verifyRoute } from '../route';

const AUTH_SERVICE_URL = 'https://dev-jin.imajin.ai/auth';
const USER_DID = 'did:imajin:user-abc';

function bearer(token: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request('https://dev-jin.imajin.ai/dykil/api/surveys', {
    headers: { authorization: `Bearer ${token}`, ...extraHeaders },
  });
}

let sessionCookieFetches = 0;

beforeEach(() => {
  delete process.env.IMAJIN_APP_AUD;
  process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
  sessionCookieFetches = 0;
  // The SDK talks to the kernel over HTTP; route its calls straight into the real handlers.
  global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith('/api/tokens/app/verify')) return verifyRoute(new Request(target, init) as never);
    if (target.endsWith('/api/session')) {
      sessionCookieFetches += 1;
      return new Response(JSON.stringify({ did: 'did:imajin:cookie-user' }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${target}`);
  }) as unknown as typeof fetch;
});

describe('dykil-configured verifier (#2706)', () => {
  it('accepts a Bearer token minted with aud: dykil', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: 'dykil', scopes: ['dykil:read'] });

    const result = await requireSessionOrAppToken(bearer(token), { slug: 'dykil' });

    expect(result).toEqual({ auth: { did: USER_DID, scopes: ['dykil:read'], via: 'token' } });
  });

  it('rejects a token minted for links', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: 'links', scopes: [] });

    const result = await requireSessionOrAppToken(bearer(token), { slug: 'dykil' });

    expect(result).toMatchObject({ status: 401 });
    expect('auth' in result).toBe(false);
  });

  it('does not fall back to a session cookie when the Bearer has the wrong audience', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: 'links', scopes: [] });

    const result = await requireSessionOrAppToken(
      bearer(token, { cookie: 'imajin_session=valid-cookie' }),
      { slug: 'dykil' },
    );

    expect(result).toMatchObject({ status: 401 });
    expect(sessionCookieFetches).toBe(0);
  });

  it('rejects a token carrying the shared host as its audience, and never verifies against the host', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: 'dev-jin.imajin.ai', scopes: [] });

    const result = await requireSessionOrAppToken(bearer(token), { slug: 'dykil' });

    expect(result).toMatchObject({ status: 401 });
  });

  it('is symmetric: a links-configured verifier rejects a dykil token and accepts its own', async () => {
    const dykilToken = await createSessionAppToken({ sub: USER_DID, aud: 'dykil', scopes: [] });
    const linksToken = await createSessionAppToken({ sub: USER_DID, aud: 'links', scopes: [] });

    expect(await requireSessionOrAppToken(bearer(dykilToken), { slug: 'links' })).toMatchObject({ status: 401 });
    expect(await requireSessionOrAppToken(bearer(linksToken), { slug: 'links' })).toHaveProperty('auth');
  });

  it('honours IMAJIN_APP_AUD over the slug default', async () => {
    process.env.IMAJIN_APP_AUD = 'links';
    const token = await createSessionAppToken({ sub: USER_DID, aud: 'links', scopes: [] });

    expect(await requireSessionOrAppToken(bearer(token), { slug: 'dykil' })).toHaveProperty('auth');
  });
});
