/**
 * Tests for GET /oauth/authorize (#1348's exact redirect_uris set match).
 *
 * Focused on the redirect_uri acceptance gate: an incoming redirect_uri must
 * be an EXACT member of the client's registered `redirect_uris` set (the
 * full set validated at DCR time), not merely share its origin. This
 * supersedes #1990's origin-level `allowed_redirect_hosts` fold-in, which was
 * broader than RFC 7591 intends (it accepted any path on a registered
 * origin, even one never actually registered).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    redirect: (url: URL | string) => new Response(null, { status: 302, headers: { Location: String(url) } }),
  },
}));

const mocks = vi.hoisted(() => {
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));
  const getEffectiveDidMock = vi.fn().mockResolvedValue({ sessionDid: 'did:imajin:user' });
  return { whereMock, selectMock, getEffectiveDidMock };
});

function nextSelect(rows: unknown[]): void {
  const p = Promise.resolve(rows) as unknown as { limit: (n: number) => Promise<unknown[]> };
  p.limit = vi.fn().mockResolvedValue(rows);
  mocks.whereMock.mockImplementationOnce(() => p);
}

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  registryApps: {
    id: 'registryApps.id',
    appDid: 'registryApps.appDid',
    callbackUrl: 'registryApps.callbackUrl',
    requestedScopes: 'registryApps.requestedScopes',
    redirectUris: 'registryApps.redirectUris',
    status: 'registryApps.status',
  },
  attestations: {},
  oauthAuthorizationCodes: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
}));

vi.mock('@imajin/config', () => ({
  rateLimit: () => ({ limited: false, retryAfter: 0 }),
  getClientIP: () => '203.0.113.1',
}));

vi.mock('@imajin/auth', () => ({
  canonicalize: (v: unknown) => JSON.stringify(v),
  crypto: { signSync: () => 'sig' },
}));

vi.mock('@/app/auth/lib/get-effective-did', () => ({
  getEffectiveDid: mocks.getEffectiveDidMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/lib/mcp/oauth-redirect', () => ({ anchorToOrigin: (url: string) => url }));
vi.mock('@/src/lib/http/public-origin', () => ({ toOrigin: (v: string | undefined) => v ?? null }));
vi.mock('@/src/lib/kernel/consent-scope-projection', () => ({ projectConsentedScopes: vi.fn() }));
vi.mock('@/src/lib/auth/promote-actor', () => ({ promoteActorOnGrant: vi.fn() }));

import { GET } from '../route';

const CLIENT_ID = 'app_typingmind';
const REGISTERED_CALLBACK = 'https://www.typingmind.com/api/mcp/oauth/callback';

function baseClientRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CLIENT_ID,
    appDid: 'did:imajin:mcp-typingmind',
    callbackUrl: REGISTERED_CALLBACK,
    requestedScopes: ['media:read'],
    redirectUris: [REGISTERED_CALLBACK],
    ...overrides,
  };
}

function authorizeRequest(params: Record<string, string>): Request {
  const url = new URL('https://kernel.test/oauth/authorize');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

const VALID_PARAMS = {
  response_type: 'code',
  client_id: CLIENT_ID,
  scope: 'media:read',
  code_challenge: 'x'.repeat(43),
  code_challenge_method: 'S256',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whereMock.mockReset();
  mocks.getEffectiveDidMock.mockResolvedValue({ sessionDid: 'did:imajin:user' });
});

describe('GET /oauth/authorize — redirect_uri exact match (#1348)', () => {
  it('accepts a redirect_uri that exactly matches the registered callbackUrl', async () => {
    nextSelect([baseClientRow()]);

    const res = await GET(authorizeRequest({ ...VALID_PARAMS, redirect_uri: REGISTERED_CALLBACK }) as never);

    expect(res.status).toBe(302);
  });

  it('rejects a redirect_uri on a completely unregistered origin', async () => {
    nextSelect([baseClientRow()]);

    const res = await GET(
      authorizeRequest({ ...VALID_PARAMS, redirect_uri: 'https://evil.example.com/callback' }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error_description).toBe('redirect_uri mismatch');
  });
});

describe('GET /oauth/authorize — full registered redirect_uris set (#1348)', () => {
  it('accepts EVERY URI in a multi-URI registered set', async () => {
    const registered = [REGISTERED_CALLBACK, 'https://www.typingmind.com/api/mcp/oauth/callback/debug'];
    for (const uri of registered) {
      nextSelect([baseClientRow({ redirectUris: registered })]);
      const res = await GET(authorizeRequest({ ...VALID_PARAMS, redirect_uri: uri }) as never);
      expect(res.status).toBe(302);
    }
  });

  it('rejects a redirect_uri on the SAME ORIGIN as a registered URI but not itself registered', async () => {
    nextSelect([baseClientRow({ redirectUris: [REGISTERED_CALLBACK] })]);

    const res = await GET(
      authorizeRequest({ ...VALID_PARAMS, redirect_uri: 'https://www.typingmind.com/some/other/path' }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error_description).toBe('redirect_uri mismatch');
  });

  it('falls back to callbackUrl when redirectUris is empty (pre-migration row, defence in depth)', async () => {
    nextSelect([baseClientRow({ callbackUrl: 'https://a.example.com/cb', redirectUris: [] })]);

    const res = await GET(
      authorizeRequest({ ...VALID_PARAMS, redirect_uri: 'https://a.example.com/cb' }) as never,
    );

    expect(res.status).toBe(302);
  });

  it('still rejects a different path when redirectUris is empty and falling back to callbackUrl', async () => {
    nextSelect([baseClientRow({ callbackUrl: 'https://a.example.com/cb', redirectUris: [] })]);

    const res = await GET(
      authorizeRequest({ ...VALID_PARAMS, redirect_uri: 'https://a.example.com/different-path' }) as never,
    );

    expect(res.status).toBe(400);
  });
});

describe('GET /oauth/authorize — unknown/revoked client (unchanged)', () => {
  it('returns 400 unauthorized_client when the client row does not exist or is inactive', async () => {
    nextSelect([]);

    const res = await GET(authorizeRequest({ ...VALID_PARAMS, redirect_uri: REGISTERED_CALLBACK }) as never);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('unauthorized_client');
  });
});
