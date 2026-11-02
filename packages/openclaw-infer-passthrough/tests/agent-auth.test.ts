import { generateKeyPairSync, sign, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAgentCredential } from '../src/agent-handler.js';
import { loadConfig } from '../src/config.js';
import { createProxyServer } from '../src/server.js';

// Ephemeral signing material only; no stored keys or production credentials.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
function jwt(claims: Record<string, unknown> = {}, header: unknown = { alg: 'EdDSA', typ: 'app+jwt' }): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode(header)}.${encode({
    azp: 'did:imajin:agent-x', sub: 'did:imajin:member', scope: 'infer:completions',
    aud: 'imajin:apps', exp: Math.floor(Date.now() / 1000) + 600, ...claims,
  })}`;
  return `${unsigned}.${sign(null, Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

describe('agent credential shape boundary', () => {
  it.each([
    undefined, '', 'imajin-local-proxy', 'one.two.three', 'e30.e30.c2ln',
    jwt({}, { typ: 'JWT', alg: 'EdDSA' }),
    jwt({}, { typ: 'app-service+jwt', alg: 'EdDSA' }),
    jwt({}, { typ: 'app+jwt', alg: 'none' }),
    jwt({}, null), jwt({ azp: undefined }), jwt({ azp: 'not-a-did' }),
    jwt({ sub: null }), jwt({ sub: 'not-a-did' }),
    jwt({ exp: undefined }), jwt({ exp: 'later' }), jwt({ exp: 0 }),
  ])('refuses a missing, malformed, wrong-type or expired credential without exposing it (case %#)', async token => {
    const result = readAgentCredential(token === undefined ? {} : { authorization: `Bearer ${token}` }, false);
    expect(result).toMatchObject({ status: 401 });
    if ('body' in result) {
      const text = await new Response(result.body).text();
      expect(text).toContain('calling agent credential');
      if (token) expect(text).not.toContain(token);
    }
  });

  it.each(['', 'not-a-did', ['did:imajin:org'], 'did:imajin:bad\nheader'])('refuses invalid selector case %#', actingAs => {
    expect(readAgentCredential({ authorization: `Bearer ${jwt()}`, 'x-acting-as': actingAs }, false))
      .toMatchObject({ status: 401 });
  });

  it('never downgrades invalid Authorization to a valid x-api-key', () => {
    expect(readAgentCredential({ authorization: 'Basic invalid', 'x-api-key': jwt() }, true))
      .toMatchObject({ status: 401 });
  });

  it('accepts x-api-key only for the Anthropic transport', () => {
    const token = jwt();
    expect(readAgentCredential({ 'x-api-key': token }, true)).toEqual({ token, actingAs: undefined });
    expect(readAgentCredential({ 'x-api-key': token }, false)).toMatchObject({ status: 401 });
  });
});

describe('default agent HTTP lane', () => {
  let server: ReturnType<typeof createProxyServer>;
  let baseUrl: string;
  let outbound: ReturnType<typeof vi.fn>;
  let kernelStatus: number;
  let kernelBody: unknown;
  let offline: boolean;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    const config = loadConfig({ KERNEL_BASE_URL: 'https://kernel.test' });
    // Deliberately configure legacy values: none may affect agent traffic.
    server = createProxyServer({
      ...config, authMode: undefined, appDid: 'did:imajin:gateway',
      routes: [{
        id: 'openai', principalDid: 'did:imajin:gateway', actingAs: 'did:imajin:wrong-org',
        directBaseUrl: 'https://direct.test', directApiKeyEnvVar: 'PATH',
      }],
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    kernelStatus = 200;
    kernelBody = { id: 'completion' };
    offline = false;
    outbound = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url.startsWith('https://kernel.test/')).toBe(true);
      expect(url).not.toContain('/auth/');
      if (offline) throw new TypeError('offline');
      const headers = new Headers(init?.headers);
      const token = headers.get('x-api-key') ?? headers.get('authorization')?.slice(7) ?? '';
      const [header, claims, signature] = token.split('.');
      if (!verify(null, Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))) {
        return Response.json({ error: 'bad signature' }, { status: 401 });
      }
      return Response.json(kernelBody, { status: kernelStatus, headers: { 'Mcp-Session-Id': 'session' } });
    });
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) =>
      url.startsWith(baseUrl) ? realFetch(url, init) : outbound(url, init)));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function request(path: string, headers: Record<string, string> = {}, body = '{"model":"grok-test","messages":[]}') {
    return fetch(`${baseUrl}${path}`, {
      method: path.endsWith('/models') ? 'GET' : 'POST', headers,
      ...(path.endsWith('/models') ? {} : { body }),
    });
  }

  it.each([
    '/openai/v1/chat/completions', '/xai/v1/chat/completions', '/v1/chat/completions',
    '/anthropic/v1/messages', '/anthropic/v1/messages/count_tokens', '/openai/v1/models', '/mcp',
  ])('keeps X and Y distinct through one server on %s, including concurrent calls', async path => {
    const tokens = [jwt({ azp: 'did:imajin:agent-x' }), jwt({ azp: 'did:imajin:agent-y' })];
    const selectors = ['did:imajin:member', 'did:imajin:org'];
    const responses = await Promise.all(tokens.map((token, i) => request(path, {
      Authorization: `Bearer ${token}`, 'x-acting-as': selectors[i],
      'x-imajin-session': `session-${i}`, 'x-imajin-turn': `turn-${i}`, 'x-imajin-run': `run-${i}`,
    })));
    expect(responses.map(res => res.status)).toEqual([200, 200]);
    expect(outbound).toHaveBeenCalledTimes(2);
    const seen = outbound.mock.calls.map(([, init]) => new Headers(init.headers));
    for (let i = 0; i < tokens.length; i++) {
      const headers = seen.find(row => (row.get('x-api-key') ?? row.get('authorization')?.slice(7)) === tokens[i]);
      expect(headers?.get('x-acting-as')).toBe(selectors[i]);
      if (path.includes('chat/completions')) {
        expect(headers?.get('x-imajin-session')).toBe(`session-${i}`);
        expect(headers?.get('x-imajin-turn')).toBe(`turn-${i}`);
        expect(headers?.get('x-imajin-run')).toBe(`run-${i}`);
      }
    }
  });

  it('does not inject a configured org selector into personal context', async () => {
    expect((await request('/openai/v1/chat/completions', { Authorization: `Bearer ${jwt()}` })).status).toBe(200);
    expect(new Headers(outbound.mock.calls[0][1].headers).has('x-acting-as')).toBe(false);
  });

  it.each([
    '/openai/v1/chat/completions', '/xai/v1/chat/completions', '/v1/chat/completions',
    '/anthropic/v1/messages', '/anthropic/v1/messages/count_tokens', '/openai/v1/models', '/mcp',
  ])('refuses missing credentials and a shared static key alone on %s without contacting the kernel', async path => {
    for (const headers of [{}, { Authorization: 'Bearer imajin-local-proxy' }, { 'x-api-key': 'imajin-local-proxy' }]) {
      const response = await request(path, headers);
      expect(response.status).toBe(401);
      expect(await response.text()).toContain('calling agent credential');
    }
    expect(outbound).not.toHaveBeenCalled();
  });

  it.each([401, 403, 500, 503])('never re-mints or falls back after kernel %s', async status => {
    kernelStatus = status;
    kernelBody = { error: status === 403 ? 'member grant required' : 'upstream refused' };
    const response = await request('/openai/v1/chat/completions', {
      Authorization: `Bearer ${jwt()}`, 'x-acting-as': 'did:imajin:org',
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject(status === 401
      ? { error: 'invalid_agent_credential', message: expect.stringContaining('calling agent credential') } : kernelBody);
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it('reports an invalid signature as the agent credential and never retries', async () => {
    const parts = jwt().split('.');
    parts[2] = Buffer.alloc(64).toString('base64url');
    const response = await request('/openai/v1/chat/completions', { Authorization: `Bearer ${parts.join('.')}` });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('calling agent credential');
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it('maps a network outage to 502 without a direct call', async () => {
    offline = true;
    expect((await request('/openai/v1/chat/completions', { Authorization: `Bearer ${jwt()}` })).status).toBe(502);
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it('forwards native Anthropic headers and token, and MCP response metadata', async () => {
    const token = jwt();
    expect((await request('/anthropic/v1/messages', {
      'x-api-key': token, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'test-beta',
    })).status).toBe(200);
    const headers = new Headers(outbound.mock.calls[0][1].headers);
    expect(headers.get('x-api-key')).toBe(token);
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('anthropic-beta')).toBe('test-beta');
    const response = await request('/mcp', { Authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-03-26', 'mcp-session-id': 'continuation' });
    expect(response.headers.get('mcp-session-id')).toBe('session');
    expect(new Headers(outbound.mock.calls[1][1].headers).get('mcp-session-id')).toBe('continuation');
  });

  it.each(['not-json', 'null', '{"model":"gpt-test","max_tokens":5}'])('leaves validation to kernel and preserves existing parameter translation: %s', async body => {
    expect((await request('/v1/chat/completions', { Authorization: `Bearer ${jwt()}` }, body)).status).toBe(200);
    const forwarded = outbound.mock.calls[0][1].body;
    expect(forwarded).toBe(body.includes('gpt-test') ? '{"model":"gpt-test","max_completion_tokens":5}' : body);
  });

  it('health is credential-free liveness only, with no host mint', async () => {
    for (const path of ['/health', '/healthz']) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ authMode: 'agent', credentialRequired: true });
    }
    expect(outbound).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown endpoints and unsupported methods without minting', async () => {
    expect((await request('/unknown')).status).toBe(404);
    expect((await fetch(`${baseUrl}/openai/v1/chat/completions`)).status).toBe(404);
    expect(outbound).not.toHaveBeenCalled();
  });
});
