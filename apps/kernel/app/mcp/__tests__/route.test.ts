/**
 * Tests for the `/mcp` auth gate's delegate-grant bearer fallback (#2252).
 * The pre-existing OAuth app+jwt path (`verifyAppToken`) is untouched and
 * not re-tested here; this file covers the NEW fallback: success, and
 * every denial reason with its stable error code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockVerifyAppToken, mockResolveDelegateGrantBearer, mockHandleMcpRpc } = vi.hoisted(() => ({
  mockVerifyAppToken: vi.fn(),
  mockResolveDelegateGrantBearer: vi.fn(),
  mockHandleMcpRpc: vi.fn(),
}));

vi.mock('@/src/lib/auth/jwt', () => ({ verifyAppToken: mockVerifyAppToken }));
vi.mock('@/src/lib/access/delegate-grant', () => ({ resolveDelegateGrantBearer: mockResolveDelegateGrantBearer }));
vi.mock('@/src/lib/mcp/server', () => ({ handleMcpRpc: mockHandleMcpRpc }));
vi.mock('@/src/lib/http/node-url', () => ({ agentCardUrl: () => 'https://imajin.ai/.well-known/agent.json' }));
vi.mock('@/src/lib/mcp/oauth-config', () => ({
  getMcpResource: () => 'https://mcp.imajin.ai/mcp',
  getProtectedResourceMetadataUrl: () => 'https://mcp.imajin.ai/.well-known/oauth-protected-resource',
  MCP_SCOPE_SET: new Set(['discovery:read', 'corpus:read']),
}));
vi.mock('@/src/lib/mcp/protocol', () => ({
  isModernProtocolVersion: () => false,
  readRequestProtocolVersion: () => null,
  validateModernRequestHeaders: () => null,
  headerMismatchError: (id: unknown) => ({ jsonrpc: '2.0', id, error: { code: -32600, message: 'mismatch' } }),
  httpStatusForModernResponse: () => 200,
}));

import { POST } from '../route';

function makeReq(opts: { authorization?: string; body?: unknown } = {}): Request {
  const headers = new Headers();
  if (opts.authorization) headers.set('authorization', opts.authorization);
  return new Request('https://mcp.imajin.ai/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyAppToken.mockResolvedValue(null);
  mockHandleMcpRpc.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { ok: true } });
});

describe('POST /mcp — no bearer', () => {
  it('returns 401 invalid_token when no Authorization header is present', async () => {
    const res = await POST(makeReq() as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_token');
    expect(mockResolveDelegateGrantBearer).not.toHaveBeenCalled();
  });
});

describe('POST /mcp — delegate-grant bearer fallback (only tried when the JWT path fails)', () => {
  it('never tries the bearer fallback when verifyAppToken succeeds', async () => {
    mockVerifyAppToken.mockResolvedValue({ sub: 'did:imajin:ryan', aud: 'https://mcp.imajin.ai/mcp', scope: 'discovery:read', azp: 'app_x' });
    await POST(makeReq({ authorization: 'Bearer some-jwt' }) as Parameters<typeof POST>[0]);
    expect(mockResolveDelegateGrantBearer).not.toHaveBeenCalled();
  });

  it('resolves to the principal DID with only the granted scopes on a valid bearer', async () => {
    mockResolveDelegateGrantBearer.mockResolvedValue({ ok: true, principalDid: 'did:imajin:ryan', scopes: ['discovery:read'], bearerId: 'dgb_1' });

    const res = await POST(makeReq({ authorization: 'Bearer plaintext-bearer' }) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(200);
    expect(mockResolveDelegateGrantBearer).toHaveBeenCalledWith('plaintext-bearer', 'mcp');
    expect(mockHandleMcpRpc).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ did: 'did:imajin:ryan', appDid: 'delegate:dgb_1', scopes: new Set(['discovery:read']) }),
    );
  });

  it('denies with 401 invalid_token for an unknown bearer', async () => {
    mockResolveDelegateGrantBearer.mockResolvedValue({ ok: false, reason: 'unknown' });
    const res = await POST(makeReq({ authorization: 'Bearer garbage' }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_token');
    expect(mockHandleMcpRpc).not.toHaveBeenCalled();
  });

  it('denies with 401 token_expired for an expired bearer (distinct stable code from invalid_token)', async () => {
    mockResolveDelegateGrantBearer.mockResolvedValue({ ok: false, reason: 'expired' });
    const res = await POST(makeReq({ authorization: 'Bearer stale' }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('token_expired');
  });

  it('denies with 403 insufficient_scope for a bearer never granted the mcp surface', async () => {
    mockResolveDelegateGrantBearer.mockResolvedValue({ ok: false, reason: 'surface_miss' });
    const res = await POST(makeReq({ authorization: 'Bearer wrong-surface' }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('insufficient_scope');
  });

  it('rejects a bearer whose granted scopes carry none of the MCP surface scopes', async () => {
    mockResolveDelegateGrantBearer.mockResolvedValue({ ok: true, principalDid: 'did:imajin:ryan', scopes: ['some-other-scope'], bearerId: 'dgb_2' });
    const res = await POST(makeReq({ authorization: 'Bearer narrow' }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(403);
    expect(mockHandleMcpRpc).not.toHaveBeenCalled();
  });
});
