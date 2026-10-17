import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST, GET, DELETE, OPTIONS } from '../route';
import { GET as metadata } from '@/app/.well-known/oauth-protected-resource/reach/[handle]/mcp/route';
import { resolveReachBearer, resolveReachRecipient } from '@/src/lib/access/reach-bearer';
import { reachPrincipalWithCredential } from '@/src/lib/auth/agent-reach';
import { reachStatus } from '@/src/lib/auth/reach-status';
import { META_PROTOCOL_VERSION } from '@/src/lib/mcp/protocol';
import { toolByName } from '@/src/lib/mcp/tools';

vi.mock('@/src/lib/access/reach-bearer', () => ({ resolveReachRecipient: vi.fn(), resolveReachBearer: vi.fn() }));
vi.mock('@/src/lib/auth/agent-reach', () => ({ reachPrincipalWithCredential: vi.fn() }));
vi.mock('@/src/lib/auth/reach-status', () => ({ reachStatus: vi.fn() }));
vi.mock('@/src/db', () => ({ db: {}, identities: {}, consentGrants: {} }));
vi.mock('@/src/lib/mcp/tools', () => ({ ALL_TOOLS: [{ name: 'owner_secret' }], toolByName: vi.fn() }));
vi.mock('@/src/lib/mcp/mcp-grant', () => ({ resolveActiveMcpGrant: vi.fn() }));

const props = (handle = 'ryan') => ({ params: Promise.resolve({ handle }) });
const credential = { requesterDid: 'did:imajin:foreign', bearerId: 'dgb_test', onBehalfOf: { platform: 'muse', externalRef: 'opaque' } };
const version = '2026-07-28';
const topic = 'business_development';

function request(method: string, params: Record<string, unknown> = {}, authorization?: string, modern = true) {
  return new NextRequest('https://node.test/reach/ryan/mcp', {
    method: 'POST',
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(modern ? { 'MCP-Protocol-Version': version, 'Mcp-Method': method, 'Mcp-Name': String(params.name ?? '') } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {
      ...params, ...(modern ? { _meta: { [META_PROTOCOL_VERSION]: version } } : {}),
    } }),
  });
}

function call(name: string, args: unknown = {}, authorization?: string, modern = true) {
  return POST(request('tools/call', { name, arguments: args }, authorization, modern), props());
}

async function content(response: Response) {
  const body = await response.json();
  expect(body.result.isError).toBe(false);
  expect(body.result.resultType).toBe('complete');
  return JSON.parse(body.result.content[0].text);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('APP_URL', 'https://node.test');
  vi.mocked(resolveReachRecipient).mockResolvedValue({
    id: 'did:imajin:ryan',
    metadata: { agentReachGate: { tiers: {}, dailyCap: 25, topics: {
      business_development: { open: true, published: true, mode: 'deliver' },
      speaking: { open: true, published: false, mode: 'deliver' },
    } }, agentReachTopics: [topic, 'speaking'], privateGateRule: 'never-disclose' },
  });
  vi.mocked(resolveReachBearer).mockResolvedValue(credential);
  vi.mocked(reachPrincipalWithCredential).mockResolvedValue({ delivered: true, reachId: 'reach_1' });
  vi.mocked(reachStatus).mockResolvedValue({ reachId: 'reach_1', state: 'replied', reply: null });
});

describe('per-principal lazy-auth MCP', () => {
  it.each([undefined, 'Bearer stale-credential'])('reads the public card without authenticating %s', async authorization => {
    const response = await call('reach_card', {}, authorization);
    expect(response.status).toBe(200);
    const card = await content(response);
    expect(card).toMatchObject({ principalDid: 'did:imajin:ryan', mcp: 'https://node.test/reach/ryan/mcp' });
    expect(card.topics).toEqual(['Business development']);
    expect(JSON.stringify(card)).not.toContain('speaking');
    expect(JSON.stringify(card)).not.toContain('never-disclose');
    expect(resolveReachBearer).not.toHaveBeenCalled();
    expect(response.headers.get('mcp-session-id')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it.each(['reach_ask', 'reach_send', 'reach_status'])('challenges anonymous %s with resource PRM and scope', async name => {
    const response = await call(name);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://node.test/.well-known/oauth-protected-resource/reach/ryan/mcp", scope="agent:reach"',
    );
    expect(response.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
    expect(reachPrincipalWithCredential).not.toHaveBeenCalled();
    expect(reachStatus).not.toHaveBeenCalled();
  });

  it.each(['reach_ask', 'reach_send', 'reach_status'])('refuses invalid/revoked/wrong-audience credentials on %s', async name => {
    vi.mocked(resolveReachBearer).mockResolvedValue(null);
    expect((await call(name, {}, 'Bearer refused')).status).toBe(401);
    expect(resolveReachBearer).toHaveBeenCalledWith('refused', 'did:imajin:ryan', name === 'reach_status' ? 'status' : 'send');
    expect(reachPrincipalWithCredential).not.toHaveBeenCalled();
    expect(reachStatus).not.toHaveBeenCalled();
  });

  it('does not accept cookie auth or a different authorization scheme', async () => {
    expect((await call('reach_send', {}, 'Basic not-a-bearer')).status).toBe(401);
    expect(resolveReachBearer).not.toHaveBeenCalled();
  });

  it('asks boolean-only through the existing gate without creating a partial delivery bundle', async () => {
    vi.mocked(reachPrincipalWithCredential).mockResolvedValue({ answer: true, transcriptHash: 'hash', issuedAt: 'now' });
    expect(await content(await call('reach_ask', { topic }, 'Bearer valid'))).toMatchObject({ answer: true });
    expect(reachPrincipalWithCredential).toHaveBeenCalledWith('did:imajin:ryan', credential, { arg: topic });
  });

  it.each([true, false])('sends in one call with static header (modern=%s)', async modern => {
    const response = await call('reach_send', { topic, message: 'Hello Ryan' }, 'Bearer valid', modern);
    expect(await content(response)).toEqual({ delivered: true, reachId: 'reach_1' });
    expect(resolveReachBearer).toHaveBeenCalledTimes(1);
    expect(reachPrincipalWithCredential).toHaveBeenCalledWith('did:imajin:ryan', credential, {
      topic, message: 'Hello Ryan', replyHandle: 'mcp:reach_status',
    });
  });

  it('passes an explicit opaque reply reference without fetching it', async () => {
    await call('reach_send', { topic, message: 'Hello', replyHandle: 'opaque:thread' }, 'Bearer valid');
    expect(reachPrincipalWithCredential).toHaveBeenCalledWith('did:imajin:ryan', credential,
      { topic, message: 'Hello', replyHandle: 'opaque:thread' });
  });

  it('accepts the exact public topic label returned by the card', async () => {
    await call('reach_send', { topic: 'Business development', message: 'Hello' }, 'Bearer valid');
    expect(reachPrincipalWithCredential).toHaveBeenCalledWith('did:imajin:ryan', credential,
      { topic, message: 'Hello', replyHandle: 'mcp:reach_status' });
  });

  it('uses the verified requester, not the recipient, to read a reply', async () => {
    const response = await call('reach_status', { reachId: 'reach_1' }, 'Bearer valid');
    expect(await content(response)).toMatchObject({ reachId: 'reach_1', state: 'replied' });
    expect(reachStatus).toHaveBeenCalledWith({ principalDid: 'did:imajin:ryan', requesterDid: credential.requesterDid, reachId: 'reach_1' });
    expect(resolveReachBearer).toHaveBeenCalledWith('valid', 'did:imajin:ryan', 'status');
  });

  it('returns a non-disclosing 404 for a foreign or missing receipt', async () => {
    vi.mocked(reachStatus).mockResolvedValue(null);
    const response = await call('reach_status', { reachId: 'foreign' }, 'Bearer valid');
    expect(response.status).toBe(404);
    expect((await response.json()).result.isError).toBe(true);
  });

  it.each([400, 401, 403, 429])('preserves canonical denial status %s', async status => {
    vi.mocked(reachPrincipalWithCredential).mockResolvedValue({ denied: true, reason: 'unauthorized', status });
    const response = await call('reach_send', { topic, message: 'Hello' }, 'Bearer valid');
    expect(response.status).toBe(status);
    if (status === 401) expect(response.headers.get('www-authenticate')).toContain('scope="agent:reach"');
    else expect((await response.json()).result.isError).toBe(true);
  });

  it.each([
    ['reach_send', { topic, message: '' }],
    ['reach_send', { topic, message: 'x'.repeat(16001) }],
    ['reach_send', { topic, message: 'hello', replyHandle: '' }],
    ['reach_send', { topic, message: 'hello', principalDid: 'did:imajin:other' }],
    ['reach_ask', { topic: ' ' }],
    ['reach_ask', { topic, message: 'not-an-ask' }],
    ['reach_status', {}],
    ['reach_status', { reachId: 'r', requesterDid: 'did:imajin:victim' }],
    ['reach_send', []],
    ['reach_send', 'invalid'],
  ])('rejects malformed/authority-bearing arguments for %s', async (name, args) => {
    const body = await (await call(name as string, args, 'Bearer valid')).json();
    expect(body.result.isError).toBe(true);
    expect(reachPrincipalWithCredential).not.toHaveBeenCalled();
    expect(reachStatus).not.toHaveBeenCalled();
  });

  it('sanitizes service errors without leaking bound parameters', async () => {
    vi.mocked(reachPrincipalWithCredential).mockRejectedValue(new Error('database contains SECRET_VALUE'));
    const response = await call('reach_send', { topic, message: 'Hello' }, 'Bearer valid');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('SECRET_VALUE');
  });

  it.each([true, false])('lists only reach tools and never falls back to owner tools (modern=%s)', async modern => {
    const response = await POST(request('tools/list', {}, undefined, modern), props());
    const body = await response.json();
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['reach_card', 'reach_ask', 'reach_send', 'reach_status']);
    expect(body.result).toMatchObject({ ttlMs: 3600000, cacheScope: 'public' });
    expect((await (await call('owner_secret', {}, 'Bearer valid', modern)).json()).error.code).toBe(-32602);
    expect(toolByName).not.toHaveBeenCalled();
  });

  it('discovers stateless 2026-07-28 without authentication or an initialize call', async () => {
    const response = await POST(request('server/discover'), props());
    expect((await response.json()).result).toMatchObject({ supportedVersions: [version, '2025-06-18', '2025-03-26'], resultType: 'complete' });
    expect(resolveReachBearer).not.toHaveBeenCalled();
    expect((await POST(request('initialize'), props())).status).toBe(404);
  });

  it('still initializes legacy static-header connectors without a session', async () => {
    const response = await POST(request('initialize', { protocolVersion: '2025-06-18' }, undefined, false), props());
    expect((await response.json()).result.protocolVersion).toBe('2025-06-18');
    expect(response.headers.get('mcp-session-id')).toBeNull();
  });

  it('rejects mirrored-header disagreement before authentication or execution', async () => {
    const req = request('tools/call', { name: 'reach_send' }, 'Bearer valid');
    req.headers.set('mcp-name', 'reach_card');
    const response = await POST(req, props());
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32020);
    expect(resolveReachBearer).not.toHaveBeenCalled();
  });

  it('rejects an unsupported version without resolving a gated credential', async () => {
    const req = new NextRequest('https://node.test/reach/ryan/mcp', { method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'reach_send', _meta: { [META_PROTOCOL_VERSION]: '2099-01-01' } } }),
    });
    const response = await POST(req, props());
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32022);
    expect(resolveReachBearer).not.toHaveBeenCalled();
  });

  it.each([null, [], [request], 42, { jsonrpc: '2.0', method: 'tools/list', params: [] }])('rejects malformed envelopes and batches', async body => {
    const response = await POST(new NextRequest('https://node.test/reach/ryan/mcp', { method: 'POST', body: JSON.stringify(body) }), props());
    expect(response.status).toBe(400);
    expect(resolveReachRecipient).not.toHaveBeenCalled();
  });

  it('returns a parse error for invalid JSON', async () => {
    const response = await POST(new NextRequest('https://node.test/reach/ryan/mcp', { method: 'POST', body: '{' }), props());
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32700);
  });

  it('acknowledges notifications without a response body', async () => {
    const response = await POST(new NextRequest('https://node.test/reach/ryan/mcp', { method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }), props());
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('does not mint an unknown recipient or leak lookup errors', async () => {
    vi.mocked(resolveReachRecipient).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('SECRET_VALUE'));
    expect((await call('reach_card')).status).toBe(404);
    const response = await call('reach_card');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('SECRET_VALUE');
  });

  it('offers CORS preflight, never SSE or session deletion', () => {
    expect(OPTIONS().status).toBe(204);
    expect(OPTIONS().headers.get('access-control-allow-headers')).toContain('Mcp-Name');
    expect(GET().status).toBe(405);
    expect(DELETE().status).toBe(405);
  });
});

describe('per-resource protected metadata', () => {
  it.each(['ryan', 'other', 'did:imajin:ryan'])('names only the addressed MCP resource (%s)', async handle => {
    const response = await metadata(new Request('https://node.test/metadata'), props(handle));
    expect(await response.json()).toEqual({
      resource: `https://node.test/reach/${encodeURIComponent(handle)}/mcp`,
      scopes_supported: ['agent:reach'], bearer_methods_supported: ['header'],
      resource_documentation: `https://node.test/reach/${encodeURIComponent(handle)}/knock`,
    });
    expect(resolveReachBearer).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown recipients and sanitizes infrastructure errors', async () => {
    vi.mocked(resolveReachRecipient).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('SECRET_VALUE'));
    expect((await metadata(new Request('https://node.test/metadata'), props())).status).toBe(404);
    const response = await metadata(new Request('https://node.test/metadata'), props());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('SECRET_VALUE');
  });
});
