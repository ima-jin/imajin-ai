/**
 * POST /oauth/register — open DCR (#1878).
 *
 * Locks down the acceptance bar for this slice: a spec-compliant remote MCP
 * client with an ARBITRARY https callback (e.g. TypingMind) must register
 * successfully with zero server-side config changes, while Claude Desktop's
 * known callbacks (and the pre-existing hardening — PKCE-only public
 * clients, MCP scope caps, per-IP rate limiting) do not regress.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
  NextRequest: class {},
  NextResponse: class extends Response {
    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      });
    }
  },
}));

vi.mock('nanoid', () => ({ nanoid: () => 'testid0000000000' }));

const { mockDbInsertValues, mockDbInsert, mockRateLimit } = vi.hoisted(() => {
  const mockDbInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockDbInsert = vi.fn(() => ({ values: mockDbInsertValues }));
  const mockRateLimit = vi.fn(() => ({ limited: false, retryAfter: 0 }));
  return { mockDbInsertValues, mockDbInsert, mockRateLimit };
});

vi.mock('@/src/db', () => ({
  db: { insert: mockDbInsert },
  registryApps: { __table: 'registryApps' },
}));

vi.mock('@imajin/config', () => ({
  rateLimit: mockRateLimit,
  getClientIP: () => '203.0.113.1',
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { POST } from '../route';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://mcp.imajin.test/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ limited: false, retryAfter: 0 });
  mockDbInsertValues.mockResolvedValue(undefined);
});

describe('POST /oauth/register — open DCR (#1878)', () => {
  it('registers a non-Anthropic https client (e.g. TypingMind) with zero server config', async () => {
    const res = await POST(
      makeRequest({
        redirect_uris: ['https://www.typingmind.com/api/mcp/oauth/callback'],
        client_name: 'TypingMind',
      }) as never,
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.redirect_uris).toEqual(['https://www.typingmind.com/api/mcp/oauth/callback']);
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(mockDbInsert).toHaveBeenCalledOnce();
    const insertedRow = mockDbInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedRow.callbackUrl).toBe('https://www.typingmind.com/api/mcp/oauth/callback');
  });

  it('still registers Claude Desktop\u2019s known callbacks (no regression)', async () => {
    const res = await POST(
      makeRequest({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        client_name: 'Claude',
      }) as never,
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.redirect_uris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });

  it('still registers a loopback client (e.g. MCP Inspector, RFC 8252)', async () => {
    const res = await POST(
      makeRequest({
        redirect_uris: [
          'http://localhost:6274/oauth/callback',
          'http://localhost:6274/oauth/callback/debug',
        ],
      }) as never,
    );

    expect(res.status).toBe(201);
  });

  it('rejects a fragment on the redirect_uri', async () => {
    const res = await POST(
      makeRequest({ redirect_uris: ['https://example.com/cb#frag'] }) as never,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_redirect_uri');
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('rejects a wildcard host in the redirect_uri', async () => {
    const res = await POST(
      makeRequest({ redirect_uris: ['https://*.example.com/cb'] }) as never,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_redirect_uri');
  });

  it('rejects a custom-scheme redirect_uri', async () => {
    const res = await POST(makeRequest({ redirect_uris: ['myapp://callback'] }) as never);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_redirect_uri');
  });

  it('rejects a non-loopback plain-http redirect_uri', async () => {
    const res = await POST(
      makeRequest({ redirect_uris: ['http://example.com/cb'] }) as never,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_redirect_uri');
  });

  it('rejects when any one of several redirect_uris is invalid', async () => {
    const res = await POST(
      makeRequest({
        redirect_uris: ['https://good.example/cb', 'https://bad.example/cb#frag'],
      }) as never,
    );

    expect(res.status).toBe(400);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('still rejects confidential-client registration (public clients only)', async () => {
    const res = await POST(
      makeRequest({
        redirect_uris: ['https://good.example/cb'],
        token_endpoint_auth_method: 'client_secret_basic',
      }) as never,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_client_metadata');
  });

  it('still caps requested scopes to the MCP surface ceiling', async () => {
    const res = await POST(
      makeRequest({
        redirect_uris: ['https://good.example/cb'],
        scope: 'media:read totally:not-a-real-scope',
      }) as never,
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.scope.split(' ')).not.toContain('totally:not-a-real-scope');
  });

  it('still rate-limits registration per IP', async () => {
    mockRateLimit.mockReturnValue({ limited: true, retryAfter: 30 });

    const res = await POST(
      makeRequest({ redirect_uris: ['https://good.example/cb'] }) as never,
    );

    expect(res.status).toBe(429);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });
});
