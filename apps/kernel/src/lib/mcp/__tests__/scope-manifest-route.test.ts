import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Tests for GET + POST /mcp/api/scope-manifest ────────────────────────────
//
// Surface-level tests: verify auth gating, body validation, delegation to the
// publisher, and shape of the JSON response. DB / manifest internals are tested
// in scope-manifest.test.ts and scope-manifest-core.test.ts.

// ── Mock next/server ─────────────────────────────────────────────────────────
function mockResponseJson(body: unknown, init?: { status?: number; headers?: unknown }) {
  return { status: init?.status ?? 200, _body: body, json: async () => body };
}

vi.mock('next/server', () => ({
  NextResponse: { json: vi.fn(mockResponseJson) },
  NextRequest: class {},
}));

// ── Mock CORS ─────────────────────────────────────────────────────────────────
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: vi.fn(() => ({})),
  corsOptions: vi.fn(() => ({ status: 204 })),
}));

// ── Mock logger ───────────────────────────────────────────────────────────────
vi.mock('@imajin/logger', () => ({ createLogger: vi.fn(() => ({ error: vi.fn() })) }));

// ── Mock auth ─────────────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  authResult: null as { identity: Record<string, unknown> } | { error: string; status: number } | null,
  actingDid: 'did:imajin:owner',
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(async () => h.authResult),
  resolveActingDid: vi.fn(() => h.actingDid),
}));

// ── Mock scope-manifest publisher ─────────────────────────────────────────────
const m = vi.hoisted(() => ({
  manifestAsset: null as { id: string } | null,
  activeScopes: [] as string[],
  publishedAssetId: 'asset_mcp_123',
}));

vi.mock('@/src/lib/mcp/scope-manifest', () => ({
  findMcpManifestAsset: vi.fn(async () => m.manifestAsset),
  readActiveMcpScopes: vi.fn(async () => m.activeScopes),
  publishMcpScopeManifest: vi.fn(async () => m.publishedAssetId),
  VALID_MCP_SCOPES: ['media:read', 'media:write', 'media:share', 'connections:read'],
}));

// Import AFTER mocks
const { GET, POST } = await import('../../../../app/mcp/api/scope-manifest/route');

function makeRequest(opts: { body?: unknown } = {}) {
  return {
    headers: { get: () => null },
    json: async () => opts.body,
  } as unknown as import('next/server').NextRequest;
}

// ── GET ───────────────────────────────────────────────────────────────────────

describe('GET /mcp/api/scope-manifest', () => {
  beforeEach(() => {
    h.authResult = { identity: {} };
    m.manifestAsset = null;
    m.activeScopes = [];
  });

  it('returns 401 when auth fails', async () => {
    h.authResult = { error: 'unauthorized', status: 401 };
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns manifestAssetId: null when no manifest exists yet', async () => {
    m.manifestAsset = null;
    m.activeScopes = [];
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifestAssetId).toBeNull();
    expect(body.activeScopes).toEqual([]);
    expect(body.validScopes).toContain('media:read');
    expect(body.validScopes).toContain('connections:read');
  });

  it('returns the manifest asset id and active scopes when a manifest exists', async () => {
    m.manifestAsset = { id: 'asset_abc' };
    m.activeScopes = ['media:read', 'connections:read'];
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.manifestAssetId).toBe('asset_abc');
    expect(body.activeScopes).toEqual(['media:read', 'connections:read']);
  });

  it('does NOT return credential booleans (native connector has no credentials)', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.configSealed).toBeUndefined();
    expect(body.tokenSealed).toBeUndefined();
  });
});

// ── POST ──────────────────────────────────────────────────────────────────────

describe('POST /mcp/api/scope-manifest', () => {
  beforeEach(() => {
    h.authResult = { identity: {} };
    m.activeScopes = ['media:read'];
  });

  it('returns 401 when auth fails', async () => {
    h.authResult = { error: 'unauthorized', status: 401 };
    const res = await POST(makeRequest({ body: { scopes: [] } }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for an invalid JSON body', async () => {
    const bad = {
      headers: { get: () => null },
      json: async () => { throw new Error('bad json'); },
    } as unknown as import('next/server').NextRequest;
    const res = await POST(bad);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid JSON body');
  });

  it('returns 400 when scopes is not an array', async () => {
    const res = await POST(makeRequest({ body: { scopes: 'media:read' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('array');
  });

  it('returns 400 for unknown scope names (fail-closed)', async () => {
    const res = await POST(makeRequest({ body: { scopes: ['media:read', 'unknown:scope'] } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('unknown:scope');
  });

  it('accepts an empty scopes array (revoke all)', async () => {
    m.activeScopes = [];
    const res = await POST(makeRequest({ body: { scopes: [] } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.published).toBe(true);
    expect(body.assetId).toBe('asset_mcp_123');
  });

  it('returns published: true, assetId, and activeScopes on success', async () => {
    m.activeScopes = ['media:read', 'connections:read'];
    const res = await POST(makeRequest({ body: { scopes: ['media:read', 'connections:read'] } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.published).toBe(true);
    expect(body.assetId).toBe('asset_mcp_123');
    expect(body.activeScopes).toEqual(['media:read', 'connections:read']);
  });

  it('returns 500 when publish throws', async () => {
    const { publishMcpScopeManifest } = await import('@/src/lib/mcp/scope-manifest');
    vi.mocked(publishMcpScopeManifest).mockRejectedValueOnce(new Error('db failure'));
    const res = await POST(makeRequest({ body: { scopes: ['media:read'] } }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Failed to publish scope manifest');
  });
});
