import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { gatewaySmoke } from '../mcp-gateway-smoke.mjs';

function fixture(overrides = {}) {
  const did = 'did:imajin:jin';
  const principal = 'did:imajin:ryan';
  const payload = Buffer.from(JSON.stringify({
    sub: did, acting_for: principal, scope: 'media:read discovery:read',
  })).toString('base64url');
  const token = `${randomBytes(8).toString('base64url')}.${payload}.${randomBytes(32).toString('base64url')}`;
  const env = { MCP_ACCESS_TOKEN: token, MCP_EXPECTED_DID: did, MCP_EXPECTED_PRINCIPAL: principal, ...overrides };
  const fetcher = vi.fn(async (_url, options) => {
    const request = JSON.parse(options.body);
    return { ok: true, json: async () => ({
      jsonrpc: '2.0', id: request.id,
      result: request.method === 'tools/list' ? { tools: [{ name: 'ping' }] }
        : { content: [{ type: 'text', text: `pong — authenticated as ${did} at now` }], isError: false },
    }) };
  });
  return { env, fetcher, token, did, principal };
}

describe('gateway smoke output and read-only policy', () => {
  it('lists tools and makes exactly one read-only call; prints only DID, scopes and pass/fail', async () => {
    const f = fixture();
    const result = await gatewaySmoke(f);
    expect(result).toEqual({ did: f.did, scopes: ['media:read', 'discovery:read'], result: 'PASS' });
    expect(JSON.stringify(result)).not.toContain(f.token);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.fetcher.mock.calls.map(([, options]) => JSON.parse(options.body).method)).toEqual(['tools/list', 'tools/call']);
    for (const [url, options] of f.fetcher.mock.calls) {
      expect(url).toBe('https://mcp.imajin.ai/mcp');
      expect(options.redirect).toBe('error');
      expect(options.headers.Authorization).toBe(`Bearer ${f.token}`);
    }
    expect(JSON.parse(f.fetcher.mock.calls[1][1].body).params).toEqual({ name: 'ping', arguments: {} });
  });
  it.each([
    { MCP_ACCESS_TOKEN: undefined }, { MCP_ACCESS_TOKEN: '' }, { MCP_ACCESS_TOKEN: '\n' },
    { MCP_EXPECTED_DID: undefined }, { MCP_EXPECTED_PRINCIPAL: undefined },
    { MCP_EXPECTED_DID: 'did:imajin:artifact-jin' }, { MCP_EXPECTED_PRINCIPAL: 'did:imajin:artifact' },
    { MCP_BASE_URL: 'http://remote.example' }, { MCP_BASE_URL: 'https://user:pass@example.test' },
    { MCP_BASE_URL: 'https://example.test/?credential=bad' }, { MCP_BASE_URL: 'https://example.test/#bad' },
    { MCP_BASE_URL: 'https://example.test/not-mcp' }, { MCP_BASE_URL: 'not a URL' },
  ])('fails closed before network for invalid env %j', async overrides => {
    const f = fixture(overrides);
    expect(await gatewaySmoke(f)).toEqual({ did: null, scopes: [], result: 'FAIL' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('allows local HTTP verification without external redirects', async () => {
    const f = fixture({ MCP_BASE_URL: 'http://127.0.0.1:7328' });
    expect((await gatewaySmoke(f)).result).toBe('PASS');
    expect(f.fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:7328/mcp');
  });
  it.each(['network', 'json', 'http', 'rpc', 'no-ping', 'wrong-did', 'tool-error'])(
    'never returns token, response body or thrown details on %s failure', async failure => {
      const f = fixture();
      const poison = randomBytes(32).toString('hex');
      f.fetcher.mockImplementation(async () => {
        if (failure === 'network') throw new Error(`${f.token} ${poison}`);
        return { ok: failure !== 'http', json: async () => {
          if (failure === 'json') throw new Error(`${f.token} ${poison}`);
          return {
            jsonrpc: '2.0', id: failure === 'rpc' ? -1 : 1,
            result: {
              tools: failure === 'no-ping' ? [] : [{ name: 'ping' }],
              content: [{ type: 'text', text: `${f.token} ${poison}` }], isError: failure === 'tool-error',
            },
          };
        } };
      });
      const result = await gatewaySmoke(f);
      expect(result).toEqual({ did: null, scopes: [], result: 'FAIL' });
      expect(JSON.stringify(result)).not.toContain(f.token);
      expect(JSON.stringify(result)).not.toContain(poison);
    },
  );
});
