import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── GET /oauth/authorize — browser-redirect origin resolution (#1797) ─────
//
// This endpoint is the generic OAuth 2.1 authorization server for EVERY
// registered third-party app (registry.apps, #244), not only the Claude/MCP
// connector. It used to anchor the login/consent redirect unconditionally to
// getMcpIssuer() (MCP_PUBLIC_URL, defaulting to https://mcp.imajin.ai) — a
// host most self-hosted nodes never configure or control. A generic app
// authorizing through the node's OWN public origin (APP_URL /
// NEXT_PUBLIC_BASE_URL) got bounced to that unrelated host instead, 404ing
// the ceremony. These tests drive the REAL route handler and assert the
// node's own trusted origin wins when configured.

const state = vi.hoisted(() => ({
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
  const limit = async () => (state.clientRow ? [state.clientRow] : []);
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
  getEffectiveDid: async () => ({ sessionDid: state.sessionDid }),
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

// #1804: POST now auto-publishes granted scopes via this helper. These tests
// only drive GET, but the route module imports it at load time, and its real
// implementation pulls in the media/asset stack (DB-backed) — stub it out.
vi.mock('@/src/lib/kernel/consent-scope-projection', () => ({
  projectConsentedScopes: vi.fn(async () => []),
}));

const { GET } = await import('../../../../app/oauth/authorize/route');
const { MCP_SCOPES } = await import('../oauth-config');

const MCP_ISSUER = 'https://mcp.imajin.ai';
const CALLBACK = 'https://integrity.example/oauth/callback';
const CHALLENGE = 'lX0o5JNheAZeS0BYnfmU97oFWi3MiIBiWHpLIqESKI8';
const [SCOPE_A] = MCP_SCOPES;

type RouteResult = { status: number; headers: { location?: string }; json(): Promise<unknown> };

function authorizeUrl() {
  const url = new URL('http://localhost:3000/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', 'app_integrity');
  url.searchParams.set('redirect_uri', CALLBACK);
  url.searchParams.set('code_challenge', CHALLENGE);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', SCOPE_A);
  return url.toString();
}

async function callAuthorize() {
  const request = {
    url: authorizeUrl(),
    headers: { get: () => null },
  } as unknown as import('next/server').NextRequest;
  return (await GET(request)) as unknown as RouteResult;
}

const originalAppUrl = process.env.APP_URL;
const originalBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;

beforeEach(() => {
  state.sessionDid = null;
  state.clientRow = {
    id: 'app_integrity',
    appDid: 'did:imajin:integrity',
    callbackUrl: CALLBACK,
    requestedScopes: [SCOPE_A],
  };
  delete process.env.APP_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
});

afterEach(() => {
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
  if (originalBaseUrl === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
  else process.env.NEXT_PUBLIC_BASE_URL = originalBaseUrl;
});

describe('GET /oauth/authorize — login redirect origin for a generic registered app', () => {
  it('anchors to the configured MCP issuer when the node has no APP_URL/NEXT_PUBLIC_BASE_URL (unchanged default)', async () => {
    const res = await callAuthorize();
    expect(res.status).toBe(307);
    expect(res.headers.location).toContain(`${MCP_ISSUER}/auth/login`);
  });

  it('prefers the node’s own APP_URL over the MCP-specific issuer (#1797)', async () => {
    process.env.APP_URL = 'https://your-node.imajin.ai';
    const res = await callAuthorize();
    expect(res.headers.location).toContain('https://your-node.imajin.ai/auth/login');
    expect(res.headers.location).not.toContain(MCP_ISSUER);
  });

  it('falls back to NEXT_PUBLIC_BASE_URL when APP_URL is unset', async () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://your-node.imajin.ai';
    const res = await callAuthorize();
    expect(res.headers.location).toContain('https://your-node.imajin.ai/auth/login');
    expect(res.headers.location).not.toContain(MCP_ISSUER);
  });

  it('preserves the authorize request in the post-login next= param on the node origin', async () => {
    process.env.APP_URL = 'https://your-node.imajin.ai';
    const res = await callAuthorize();
    const next = new URL(res.headers.location as string).searchParams.get('next');
    expect(next).toBeTruthy();
    expect(next).toContain('https://your-node.imajin.ai/oauth/authorize');
    expect(next).toContain('client_id=app_integrity');
  });
});
