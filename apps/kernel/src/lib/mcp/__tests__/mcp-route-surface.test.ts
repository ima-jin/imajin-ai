import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock next/server ───────────────────────────────────────────────────────
function mockNextResponseJson(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return {
    status: init?.status ?? 200,
    headers: new Headers(init?.headers ?? {}),
    json: async () => body,
  };
}

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn(mockNextResponseJson),
  },
  NextRequest: class {},
}));

// ─── Mock oauth-config ──────────────────────────────────────────────────────
const TEST_ISSUER = 'https://mcp.imajin.ai';
const TEST_RESOURCE = `${TEST_ISSUER}/mcp`;
const TEST_METADATA_URL = `${TEST_ISSUER}/.well-known/oauth-protected-resource`;

vi.mock('@/src/lib/mcp/oauth-config', () => ({
  getMcpResource: vi.fn(() => TEST_RESOURCE),
  getProtectedResourceMetadataUrl: vi.fn(() => TEST_METADATA_URL),
  MCP_SCOPE_SET: new Set([
    'media:read',
    'media:write',
    'media:share',
    'connections:read',
    'messages:read',
    'messages:write',
    'github:read',
    'github:write',
    'github:org',
    'github:actions',
    'warp:dispatch',
    'discovery:read',
    'inference:read',
    'inference:write',
  ]),
}));

// ─── Mock auth/jwt ──────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  tokenPayload: null as Record<string, unknown> | null,
}));

vi.mock('@/src/lib/auth/jwt', () => ({
  verifyAppToken: vi.fn(async (_token: string) => h.tokenPayload),
}));

// ─── Mock server ────────────────────────────────────────────────────────────
vi.mock('@/src/lib/mcp/server', () => ({
  handleMcpRpc: vi.fn(async (_msg: unknown, _ctx: unknown) => ({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: 'pong' }] },
  })),
}));

// Import AFTER mocks are registered
const { POST } = await import('../../../../app/mcp/route');
import { verifyAppToken } from '@/src/lib/auth/jwt';
import { handleMcpRpc } from '@/src/lib/mcp/server';

function makeRequest(opts: {
  auth?: string;
  body?: unknown;
  protocolVersion?: string;
  headers?: Record<string, string>;
}) {
  const headers = new Headers();
  if (opts.auth) headers.set('authorization', opts.auth);
  if (opts.protocolVersion) headers.set('mcp-protocol-version', opts.protocolVersion);
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);

  return {
    headers: {
      get: (name: string) => headers.get(name),
    },
    json: async () => opts.body,
  } as unknown as import('next/server').NextRequest;
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'did:imajin:user',
    aud: TEST_RESOURCE,
    scope: 'media:read',
    azp: 'did:imajin:app',
    ...overrides,
  };
}

describe('POST /mcp surface scope gate (#1337)', () => {
  const originalEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['APP_URL', 'NEXT_PUBLIC_BASE_URL', 'NEXT_PUBLIC_SERVICE_PREFIX', 'NEXT_PUBLIC_DOMAIN'];

  beforeEach(() => {
    h.tokenPayload = null;
    vi.mocked(verifyAppToken).mockClear();
    vi.mocked(handleMcpRpc).mockClear();
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('returns 401 when no Bearer header is present', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('invalid_token');
  });

  // #1899 — an unknown/ungranted key needs to be told where the front door is.
  it('includes an onboarding pointer to the agent card on 401', async () => {
    process.env.APP_URL = 'https://jin.imajin.ai';
    const res = await POST(makeRequest({}));
    const json = await res.json();
    expect(json.onboarding).toBe('https://jin.imajin.ai/.well-known/agent.json');
  });

  it('returns 401 when token verification fails', async () => {
    h.tokenPayload = null;
    const res = await POST(makeRequest({ auth: 'Bearer badtoken' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when audience does not match', async () => {
    h.tokenPayload = validPayload({ aud: 'wrong-audience' });
    const res = await POST(makeRequest({ auth: 'Bearer token', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
    expect(res.status).toBe(401);
  });

  it('allows a media:read token through the surface gate', async () => {
    h.tokenPayload = validPayload({ scope: 'media:read' });
    const res = await POST(makeRequest({ auth: 'Bearer token', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
    expect(res.status).toBe(200);
  });

  it('allows a media:write token through the surface gate', async () => {
    h.tokenPayload = validPayload({ scope: 'media:write' });
    const res = await POST(makeRequest({ auth: 'Bearer token', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
    expect(res.status).toBe(200);
  });

  it('allows a github:read token through the surface gate', async () => {
    h.tokenPayload = validPayload({ scope: 'github:read' });
    const res = await POST(makeRequest({ auth: 'Bearer token', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
    expect(res.status).toBe(200);
  });

  it('allows a messages:read token through the surface gate', async () => {
    h.tokenPayload = validPayload({ scope: 'messages:read' });
    const res = await POST(makeRequest({ auth: 'Bearer token', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
    expect(res.status).toBe(200);
  });

  it('allows a messages:write token through the surface gate', async () => {
    h.tokenPayload = validPayload({ scope: 'messages:write' });
    const res = await POST(makeRequest({ auth: 'Bearer token', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
    expect(res.status).toBe(200);
  });

  it('allows a github:write token through the surface gate', async () => {
    h.tokenPayload = validPayload({ scope: 'github:write' });
    const res = await POST(makeRequest({ auth: 'Bearer token', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
    expect(res.status).toBe(200);
  });

  /**
   * #1636: a Warp agent connecting purely to read specs holds nothing else, so a
   * `discovery:read`-only token has to clear the surface gate on its own —
   * otherwise the scope is grantable but unusable.
   */
  it('allows a discovery:read-only token through the surface gate', async () => {
    h.tokenPayload = validPayload({ scope: 'discovery:read' });
    const res = await POST(makeRequest({ auth: 'Bearer token', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
    expect(res.status).toBe(200);
  });

  /**
   * #1298: an agent granted only the inference surface holds no media scope, so
   * `inference:*` has to clear the surface gate on its own — otherwise the split
   * from `media:*` makes the tools unreachable.
   */
  it.each(['inference:read', 'inference:write'])('allows a %s-only token through the surface gate', async (scope) => {
    h.tokenPayload = validPayload({ scope });
    const res = await POST(makeRequest({ auth: 'Bearer token', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
    expect(res.status).toBe(200);
  });

  it('allows a mixed-scope token through the surface gate', async () => {
    h.tokenPayload = validPayload({ scope: 'github:read media:write connections:read' });
    const res = await POST(makeRequest({ auth: 'Bearer token', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
    expect(res.status).toBe(200);
  });

  it('rejects 403 when token has no recognized MCP scopes', async () => {
    h.tokenPayload = validPayload({ scope: 'unknown:scope some:other' });
    const res = await POST(makeRequest({ auth: 'Bearer token', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('insufficient_scope');
  });

  // #1899 — a recognized-but-ungranted key gets the same onboarding pointer.
  it('includes an onboarding pointer to the agent card on 403 insufficient_scope', async () => {
    process.env.APP_URL = 'https://jin.imajin.ai';
    h.tokenPayload = validPayload({ scope: 'unknown:scope' });
    const res = await POST(makeRequest({ auth: 'Bearer token', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
    const json = await res.json();
    expect(json.onboarding).toBe('https://jin.imajin.ai/.well-known/agent.json');
  });

  it('rejects 403 when token has empty scope', async () => {
    h.tokenPayload = validPayload({ scope: '' });
    const res = await POST(makeRequest({ auth: 'Bearer token', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('insufficient_scope');
  });

  it('rejects 403 when token has no scope field at all', async () => {
    const payload = validPayload();
    delete (payload as Record<string, unknown>).scope;
    h.tokenPayload = payload;
    const res = await POST(makeRequest({ auth: 'Bearer token', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('insufficient_scope');
  });

  it('dispatches to handleMcpRpc after passing the gate', async () => {
    h.tokenPayload = validPayload({ scope: 'github:read' });
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    await POST(makeRequest({ auth: 'Bearer token', body }));
    expect(handleMcpRpc).toHaveBeenCalledTimes(1);
    const [, ctx] = vi.mocked(handleMcpRpc).mock.calls[0];
    expect((ctx as Record<string, unknown>).did).toBe('did:imajin:user');
    expect((ctx as Record<string, unknown>).appDid).toBe('did:imajin:app');
    const scopes = (ctx as Record<string, unknown>).scopes as Set<string>;
    expect(scopes.has('github:read')).toBe(true);
  });
});

/**
 * 2026-07-28 transport rules (#1474).
 *
 * These are the parts of the revision the ROUTE owns rather than the
 * dispatcher: mirrored-header validation and the 4xx mapping a dual-era client
 * relies on to tell a modern server from a legacy one. Dispatch itself is
 * mocked here — see protocol-2026-07-28.test.ts for that half.
 */
describe('POST /mcp modern transport (2026-07-28)', () => {
  const MODERN = '2026-07-28';
  const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

  function modernBody(method: string, params: Record<string, unknown> = {}, version = MODERN) {
    return {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          [META_VERSION]: version,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    };
  }

  beforeEach(() => {
    h.tokenPayload = validPayload({ scope: 'media:read' });
    vi.mocked(handleMcpRpc).mockClear();
  });

  it('accepts a well-formed modern request and echoes the version header', async () => {
    const res = await POST(
      makeRequest({
        auth: 'Bearer token',
        protocolVersion: MODERN,
        headers: { 'mcp-method': 'tools/list' },
        body: modernBody('tools/list'),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('MCP-Protocol-Version')).toBe(MODERN);
    expect(handleMcpRpc).toHaveBeenCalledTimes(1);
  });

  it('rejects a modern request with no Mcp-Method header (HeaderMismatch)', async () => {
    const res = await POST(
      makeRequest({
        auth: 'Bearer token',
        protocolVersion: MODERN,
        body: modernBody('tools/list'),
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe(-32020);
    expect(json.error.message).toContain('Mcp-Method');
    // Rejected at the transport seam — dispatch must not see it.
    expect(handleMcpRpc).not.toHaveBeenCalled();
  });

  it('rejects a header/body protocol-version disagreement', async () => {
    const res = await POST(
      makeRequest({
        auth: 'Bearer token',
        protocolVersion: MODERN,
        headers: { 'mcp-method': 'tools/list' },
        body: modernBody('tools/list', {}, '2025-06-18'),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32020);
  });

  it('rejects an Mcp-Name that disagrees with params.name', async () => {
    const res = await POST(
      makeRequest({
        auth: 'Bearer token',
        protocolVersion: MODERN,
        headers: { 'mcp-method': 'tools/call', 'mcp-name': 'other_tool' },
        body: modernBody('tools/call', { name: 'media_list', arguments: {} }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('Mcp-Name');
  });

  it('returns 400 for an UnsupportedProtocolVersionError', async () => {
    vi.mocked(handleMcpRpc).mockResolvedValueOnce({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32022, message: 'Unsupported protocol version' },
    });
    const res = await POST(
      makeRequest({
        auth: 'Bearer token',
        protocolVersion: MODERN,
        headers: { 'mcp-method': 'tools/list' },
        body: modernBody('tools/list'),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown method under the modern transport', async () => {
    vi.mocked(handleMcpRpc).mockResolvedValueOnce({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found: ping' },
    });
    const res = await POST(
      makeRequest({
        auth: 'Bearer token',
        protocolVersion: MODERN,
        headers: { 'mcp-method': 'ping' },
        body: modernBody('ping'),
      }),
    );
    expect(res.status).toBe(404);
  });

  /**
   * The compatibility guarantee: none of the above may leak onto clients that
   * never asked for 2026-07-28. A legacy request carries none of the mirrored
   * headers and still gets an unconditional 200, JSON-RPC error or not.
   */
  it('leaves legacy requests unvalidated and at HTTP 200', async () => {
    vi.mocked(handleMcpRpc).mockResolvedValueOnce({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found: nope' },
    });
    const res = await POST(
      makeRequest({
        auth: 'Bearer token',
        protocolVersion: '2025-06-18',
        body: { jsonrpc: '2.0', id: 1, method: 'nope' },
      }),
    );
    expect(res.status).toBe(200);
    expect(handleMcpRpc).toHaveBeenCalledTimes(1);
  });

  it('leaves a legacy request with no version header at HTTP 200', async () => {
    const res = await POST(
      makeRequest({
        auth: 'Bearer token',
        body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      }),
    );
    expect(res.status).toBe(200);
  });
});
