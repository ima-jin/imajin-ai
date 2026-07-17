import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    'github:read',
    'github:write',
    'github:org',
    'github:actions',
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

function makeRequest(opts: { auth?: string; body?: unknown; protocolVersion?: string }) {
  const headers = new Headers();
  if (opts.auth) headers.set('authorization', opts.auth);
  if (opts.protocolVersion) headers.set('mcp-protocol-version', opts.protocolVersion);

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
  beforeEach(() => {
    h.tokenPayload = null;
    vi.mocked(verifyAppToken).mockClear();
    vi.mocked(handleMcpRpc).mockClear();
  });

  it('returns 401 when no Bearer header is present', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('invalid_token');
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

  it('allows a github:write token through the surface gate', async () => {
    h.tokenPayload = validPayload({ scope: 'github:write' });
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
