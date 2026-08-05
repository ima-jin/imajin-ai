import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── GET /oauth/authorize — scope-gate handshake ────────────────────────────
//
// Regression cover for the RFC 6749 §3.3 default-scope bug: an authorization
// request that OMITS `scope` used to be rejected with `error=invalid_scope`,
// dead-ending the ceremony before the login/consent step. §3.3 makes `scope`
// OPTIONAL and requires the AS to fall back to a pre-defined default, which for
// a dynamically registered client is the set it registered at DCR time.
//
// These tests drive the REAL route handler with only its I/O edges mocked (db,
// session, rate-limit, logger), so the scope gate itself is exercised for real
// via resolveGrantedScopes().

const h = vi.hoisted(() => ({
  clientRow: null as Record<string, unknown> | null,
  sessionDid: null as string | null,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      headers: { location: undefined as string | undefined },
      json: async () => body,
    })),
    redirect: vi.fn((url: string | URL) => ({
      status: 307,
      headers: { location: String(url) },
      json: async () => ({}),
    })),
  },
  NextRequest: class {},
}));

vi.mock('nanoid', () => ({ nanoid: () => 'testid0000000000' }));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/src/db', () => {
  // Flattened rather than nested inline so the drizzle builder chain stays
  // readable (and under the nested-function lint bound).
  const limit = async () => (h.clientRow ? [h.clientRow] : []);
  const where = () => ({ limit });
  const from = () => ({ where });
  return {
    db: { select: () => ({ from }) },
    registryApps: {},
    attestations: {},
    oauthAuthorizationCodes: {},
  };
});

vi.mock('@imajin/auth', () => ({
  canonicalize: (v: unknown) => JSON.stringify(v),
  crypto: { signSync: () => 'sig' },
}));

vi.mock('@/app/auth/lib/get-effective-did', () => ({
  getEffectiveDid: async () => ({ sessionDid: h.sessionDid }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@imajin/config', () => ({
  rateLimit: () => ({ limited: false, retryAfter: 0 }),
  getClientIP: () => '127.0.0.1',
}));

vi.mock('@/src/lib/auth/promote-actor', () => ({
  promoteActorOnGrant: vi.fn(async () => undefined),
}));

// Import AFTER mocks. oauth-config + oauth-redirect stay REAL — the whole point
// is to exercise the actual scope resolution.
const { GET } = await import('../../../../app/oauth/authorize/route');
const { MCP_SCOPES } = await import('../oauth-config');

const ISSUER = 'https://mcp.imajin.ai';
const CALLBACK = 'http://127.0.0.1:33418/oauth/callback';
const CHALLENGE = 'lX0o5JNheAZeS0BYnfmU97oFWi3MiIBiWHpLIqESKI8';

const [SCOPE_A, SCOPE_B] = MCP_SCOPES;

type RouteResult = { status: number; headers: { location?: string }; json(): Promise<unknown> };

/**
 * Build an authorize URL. Pass `scope: undefined` to OMIT the param entirely —
 * that absence is the exact condition under test.
 */
function authorizeUrl(opts: { scope?: string; redirectUri?: string } = {}) {
  const url = new URL(`${ISSUER}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', 'app_test');
  url.searchParams.set('redirect_uri', opts.redirectUri ?? CALLBACK);
  url.searchParams.set('code_challenge', CHALLENGE);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', 'probe');
  if (opts.scope !== undefined) url.searchParams.set('scope', opts.scope);
  return url.toString();
}

async function callAuthorize(opts: { scope?: string; redirectUri?: string } = {}) {
  const request = {
    url: authorizeUrl(opts),
    headers: { get: () => null },
  } as unknown as import('next/server').NextRequest;
  return (await GET(request)) as unknown as RouteResult;
}

/** Pull the `scope` the handler forwarded to the consent UI. */
function consentScope(location: string): string | null {
  return new URL(location).searchParams.get('scope');
}

beforeEach(() => {
  h.sessionDid = null;
  h.clientRow = {
    id: 'app_test',
    appDid: 'did:imajin:mcp-test',
    callbackUrl: CALLBACK,
    requestedScopes: [SCOPE_A, SCOPE_B],
  };
});

describe('GET /oauth/authorize — absent scope (RFC 6749 §3.3)', () => {
  it('reaches the login step instead of dead-ending on invalid_scope', async () => {
    const res = await callAuthorize(); // no `scope` param at all
    expect(res.status).toBe(307);
    expect(res.headers.location).toBeDefined();
    expect(res.headers.location).toContain(`${ISSUER}/auth/login`);
  });

  it('does NOT emit error=invalid_scope when scope is omitted (the regression)', async () => {
    const res = await callAuthorize();
    expect(res.headers.location).not.toContain('error=invalid_scope');
  });

  it('preserves the authorize request in the post-login `next` param', async () => {
    const res = await callAuthorize();
    const next = new URL(res.headers.location as string).searchParams.get('next');
    expect(next).toBeTruthy();
    expect(next).toContain('/oauth/authorize');
    expect(next).toContain('client_id=app_test');
  });

  it('defaults to the client\u2019s full registered set once a session exists', async () => {
    h.sessionDid = 'did:imajin:owner';
    const res = await callAuthorize();
    expect(res.headers.location).toContain(`${ISSUER}/auth/authorize`);
    expect(consentScope(res.headers.location as string)).toBe(`${SCOPE_A} ${SCOPE_B}`);
  });
});

describe('GET /oauth/authorize — explicit scope still constrained', () => {
  beforeEach(() => {
    h.sessionDid = 'did:imajin:owner';
  });

  it('honours an explicit subset of the registered scopes', async () => {
    const res = await callAuthorize({ scope: SCOPE_A });
    expect(consentScope(res.headers.location as string)).toBe(SCOPE_A);
  });

  it('narrows an over-broad explicit scope to what the client registered', async () => {
    h.clientRow = { ...h.clientRow, requestedScopes: [SCOPE_A] };
    const res = await callAuthorize({ scope: `${SCOPE_A} ${SCOPE_B}` });
    expect(consentScope(res.headers.location as string)).toBe(SCOPE_A);
  });

  it('rejects an explicit scope that overlaps nothing registered', async () => {
    h.clientRow = { ...h.clientRow, requestedScopes: [SCOPE_A] };
    const res = await callAuthorize({ scope: SCOPE_B });
    expect(res.headers.location).toContain('error=invalid_scope');
  });

  it('rejects an unknown scope string outside the MCP ceiling', async () => {
    const res = await callAuthorize({ scope: 'totally:not-a-real-scope' });
    expect(res.headers.location).toContain('error=invalid_scope');
  });
});

describe('GET /oauth/authorize — invalid_scope preserved where it is correct', () => {
  it('still fails when the client registered no scopes and sends none', async () => {
    h.clientRow = { ...h.clientRow, requestedScopes: [] };
    const res = await callAuthorize();
    expect(res.headers.location).toContain('error=invalid_scope');
  });

  it('still fails when requestedScopes is null and none are sent', async () => {
    h.clientRow = { ...h.clientRow, requestedScopes: null };
    const res = await callAuthorize();
    expect(res.headers.location).toContain('error=invalid_scope');
  });
});

describe('GET /oauth/authorize — earlier gates unaffected', () => {
  it('rejects a redirect_uri that does not match the registered callback', async () => {
    const res = await callAuthorize({ redirectUri: 'https://evil.example/cb' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('rejects an unknown client before any scope handling', async () => {
    h.clientRow = null;
    const res = await callAuthorize();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unauthorized_client' });
  });
});
