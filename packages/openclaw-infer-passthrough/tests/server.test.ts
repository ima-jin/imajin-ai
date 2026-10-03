import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createProxyServer } from '../src/server.js';
import type { ProxyConfig } from '../src/types.js';

const CONFIG: ProxyConfig = {
  host: '127.0.0.1',
  port: 0,
  kernelBaseUrl: 'https://kernel.test',
  kernelTimeoutMs: 5_000,
  directTimeoutMs: 5_000,
  appDid: 'did:imajin:app',
  appPrivateKey: 'ab'.repeat(32),
  mcpPublicUrl: 'https://mcp.test',
  routes: [
    { id: 'xai', principalDid: 'did:imajin:ryan', attestationId: 'att-xai', modelPrefixes: ['grok-'] },
    { id: 'anthropic', principalDid: 'did:imajin:ryan', attestationId: 'att-anthropic', modelPrefixes: ['claude-'] },
    { id: 'openai', principalDid: 'did:imajin:ryan', attestationId: 'att-openai', modelPrefixes: ['gpt-', 'o1-', 'o3-'] },
    { id: 'mcp', principalDid: 'did:imajin:ryan', attestationId: 'att-mcp' },
  ],
};

let server: ReturnType<typeof createProxyServer>;
let baseUrl: string;

beforeEach(async () => {
  server = createProxyServer(CONFIG);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('proxy server (integration)', () => {
  it('GET /healthz returns the health snapshot shape', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ kernelOk: true, fallbackCount: 0, fallbackRate: 0, lastFallbackAt: null });
  });

  it('mints a token and forwards a completions request end to end, streaming the response back', async () => {
    // Only the shim's own outbound calls to `kernel.test` are mocked — the
    // test's own request to the local server (`baseUrl`, a real 127.0.0.1
    // socket) must fall through to the real global fetch, or it would
    // recursively hit this same mock instead of the server under test.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === 'https://kernel.test/auth/api/apps/token') {
          return new Response(JSON.stringify({ token: 'tok-e2e', expiresIn: 600, scopes: ['infer:completions'] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === 'https://kernel.test/infer/v1/chat/completions') {
          return new Response(JSON.stringify({ id: 'chatcmpl-e2e' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.startsWith(baseUrl)) {
          return realFetch(url, init);
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );

    const res = await fetch(`${baseUrl}/xai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'grok-4', messages: [] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'chatcmpl-e2e' });
  });

  it('returns 404 for an unknown route', async () => {
    const res = await fetch(`${baseUrl}/not-a-real-path`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unrecognised provider path segment (#2453)', async () => {
    const res = await fetch(`${baseUrl}/not-configured/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('mints a token and forwards an Anthropic-format /anthropic/v1/messages request end to end (#1959)', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === 'https://kernel.test/auth/api/apps/token') {
          return new Response(JSON.stringify({ token: 'tok-e2e', expiresIn: 600, scopes: ['infer:completions'] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === 'https://kernel.test/infer/v1/messages') {
          expect((init?.headers as Record<string, string>)['x-api-key']).toBe('tok-e2e');
          return new Response(JSON.stringify({ id: 'msg-e2e' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.startsWith(baseUrl)) {
          return realFetch(url, init);
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );

    const res = await fetch(`${baseUrl}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'msg-e2e' });
  });

  it('forwards an Anthropic-format /anthropic/v1/messages/count_tokens request to the kernel count_tokens route', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === 'https://kernel.test/auth/api/apps/token') {
          return new Response(JSON.stringify({ token: 'tok-e2e', expiresIn: 600, scopes: ['infer:completions'] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === 'https://kernel.test/infer/v1/messages/count_tokens') {
          return new Response(JSON.stringify({ input_tokens: 5 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.startsWith(baseUrl)) {
          return realFetch(url, init);
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );

    const res = await fetch(`${baseUrl}/anthropic/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ input_tokens: 5 });
  });

  it('forwards X-Imajin-Session/Turn/Run headers to the kernel completions route (#2204)', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === 'https://kernel.test/auth/api/apps/token') {
          return new Response(JSON.stringify({ token: 'tok-e2e', expiresIn: 600, scopes: ['infer:completions'] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === 'https://kernel.test/infer/v1/chat/completions') {
          const headers = init?.headers as Record<string, string>;
          expect(headers['X-Imajin-Session']).toBe('sess-123');
          expect(headers['X-Imajin-Turn']).toBe('turn-456');
          expect(headers['X-Imajin-Run']).toBe('run-789');
          return new Response(JSON.stringify({ id: 'chatcmpl-e2e' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.startsWith(baseUrl)) {
          return realFetch(url, init);
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );

    const res = await fetch(`${baseUrl}/xai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Imajin-Session': 'sess-123',
        'X-Imajin-Turn': 'turn-456',
        'X-Imajin-Run': 'run-789',
      },
      body: JSON.stringify({ model: 'grok-4', messages: [] }),
    });

    expect(res.status).toBe(200);
  });

  it('falls back to legacy X-Session-Id/X-Turn-Id headers when X-Imajin-* is absent (#2204)', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === 'https://kernel.test/auth/api/apps/token') {
          return new Response(JSON.stringify({ token: 'tok-e2e', expiresIn: 600, scopes: ['infer:completions'] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === 'https://kernel.test/infer/v1/chat/completions') {
          const headers = init?.headers as Record<string, string>;
          expect(headers['X-Imajin-Session']).toBe('legacy-sess');
          expect(headers['X-Imajin-Turn']).toBe('legacy-turn');
          expect(headers['X-Imajin-Run']).toBeUndefined();
          return new Response(JSON.stringify({ id: 'chatcmpl-e2e' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.startsWith(baseUrl)) {
          return realFetch(url, init);
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );

    const res = await fetch(`${baseUrl}/xai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': 'legacy-sess',
        'X-Turn-Id': 'legacy-turn',
      },
      body: JSON.stringify({ model: 'grok-4', messages: [] }),
    });

    expect(res.status).toBe(200);
  });

  it('mints a token and forwards POST /mcp to the kernel end to end, minting with the MCP resource audience (#2368)', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === 'https://kernel.test/auth/api/apps/token') {
          const body = JSON.parse(init!.body as string) as { scope?: string; aud?: string };
          expect(body.scope).toBeUndefined();
          expect(body.aud).toBe('https://mcp.test/mcp');
          return new Response(JSON.stringify({ token: 'tok-mcp-e2e', expiresIn: 600, scopes: ['media:read'] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === 'https://kernel.test/mcp') {
          expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-mcp-e2e');
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.startsWith(baseUrl)) {
          return realFetch(url, init);
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
  });

  it('returns 403 insufficient_scope for POST /mcp when the minted token carries no MCP-surface scope (#2368)', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === 'https://kernel.test/auth/api/apps/token') {
          return new Response(JSON.stringify({ token: 'tok-mcp-e2e', expiresIn: 600, scopes: ['infer:completions'] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.startsWith(baseUrl)) {
          return realFetch(url, init);
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('insufficient_scope');
  });

  it('mints a token and forwards GET /openai/v1/models to the kernel end to end (#2201)', async () => {
    const realFetch = globalThis.fetch;
    const modelsBody = { object: 'list', data: [{ id: 'gpt-6-astra', object: 'model', owned_by: 'openai', created: 1_700_000_000 }] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === 'https://kernel.test/auth/api/apps/token') {
          return new Response(JSON.stringify({ token: 'tok-e2e', expiresIn: 600, scopes: ['infer:completions'] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === 'https://kernel.test/infer/v1/models/usable') {
          expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-e2e');
          return new Response(JSON.stringify(modelsBody), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.startsWith(baseUrl)) {
          return realFetch(url, init);
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );

    const res = await fetch(`${baseUrl}/openai/v1/models`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(modelsBody);
  });
});

describe('proxy server — proper status codes instead of a generic 500 (#2453)', () => {
  const MINT_URL = 'https://kernel.test/auth/api/apps/token';
  const COMPLETIONS_URL = 'https://kernel.test/infer/v1/chat/completions';
  const MODELS_URL = 'https://kernel.test/infer/v1/models/usable';
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const goodMint = () =>
    new Response(JSON.stringify({ token: 'tok-ok', expiresIn: 600, scopes: ['infer:completions'] }), { status: 200, headers: jsonHeaders });

  /** Stub only the shim's outbound kernel calls; the test's own calls to the local server fall through to the real fetch. */
  function stubKernel(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const realFetch = globalThis.fetch;
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith(baseUrl)) return realFetch(url, init);
      return handler(url, init);
    });
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  function post(path: string, body: unknown) {
    return fetch(`${baseUrl}${path}`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
  }

  it('keyless request (kernel refuses the app-token mint) → 401, not 500', async () => {
    stubKernel((url) => {
      if (url === MINT_URL) return new Response(JSON.stringify({ error: 'invalid signature' }), { status: 401, headers: jsonHeaders });
      throw new Error(`unexpected fetch to ${url}`);
    });

    const res = await post('/openai/v1/chat/completions', { model: 'grok-4', messages: [] });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(JSON.stringify(body)).not.toContain('ab'.repeat(32));
  });

  it('unknown model on the unprefixed path → 404', async () => {
    const fetchMock = stubKernel(() => {
      throw new Error('kernel must not be called');
    });

    const res = await post('/v1/chat/completions', { model: 'no-such-model', messages: [] });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('no_route_for_model');
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the test's own call to the shim
  });

  it('kernel-reported unknown model (404) is forwarded verbatim', async () => {
    stubKernel((url) => {
      if (url === MINT_URL) return goodMint();
      return new Response(JSON.stringify({ error: 'model_not_found' }), { status: 404, headers: jsonHeaders });
    });

    const res = await post('/openai/v1/chat/completions', { model: 'mystery-model', messages: [] });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('model_not_found');
  });

  it('grok-4 on the /openai/v1 seat mints against the xai attestation and is not a 500', async () => {
    const mintedFor: string[] = [];
    stubKernel((url, init) => {
      if (url === MINT_URL) {
        mintedFor.push(JSON.parse(init?.body as string).attestationId);
        return goodMint();
      }
      if (url === COMPLETIONS_URL) return new Response(JSON.stringify({ id: 'chatcmpl-grok' }), { status: 200, headers: jsonHeaders });
      throw new Error(`unexpected fetch to ${url}`);
    });

    const res = await post('/openai/v1/chat/completions', { model: 'grok-4', messages: [] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'chatcmpl-grok' });
    expect(mintedFor).toEqual(['att-xai']);
  });

  it('valid model with a failing upstream (kernel 500, no fallback) → 502', async () => {
    stubKernel((url) => {
      if (url === MINT_URL) return goodMint();
      return new Response(JSON.stringify({ error: 'upstream exploded' }), { status: 500, headers: jsonHeaders });
    });

    const res = await post('/openai/v1/chat/completions', { model: 'grok-4', messages: [] });

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('kernel_unavailable');
  });

  it('kernel unreachable during the token mint → 502, not 500', async () => {
    stubKernel(() => {
      throw new TypeError('fetch failed');
    });

    const res = await post('/openai/v1/chat/completions', { model: 'grok-4', messages: [] });

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('kernel_unavailable');
  });

  it('GET /xai/v1/models and GET /v1/models answer instead of 404 (#2453)', async () => {
    const modelsBody = { object: 'list', data: [{ id: 'grok-4', object: 'model' }] };
    stubKernel((url) => {
      if (url === MINT_URL) return goodMint();
      if (url === MODELS_URL) return new Response(JSON.stringify(modelsBody), { status: 200, headers: jsonHeaders });
      throw new Error(`unexpected fetch to ${url}`);
    });

    for (const path of ['/xai/v1/models', '/v1/models', '/openai/v1/models']) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.json()).toEqual(modelsBody);
    }
  });

  it('GET /models for an unconfigured provider → 404; for the mcp route → 404', async () => {
    stubKernel(() => {
      throw new Error('kernel must not be called');
    });

    expect((await fetch(`${baseUrl}/nope/v1/models`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/mcp/v1/models`)).status).toBe(404);
  });

  it('GET /openai/v1/models with the mint refused → 401, not 500', async () => {
    stubKernel((url) => {
      if (url === MINT_URL) return new Response(JSON.stringify({ error: 'attestation not found' }), { status: 404, headers: jsonHeaders });
      throw new Error(`unexpected fetch to ${url}`);
    });

    const res = await fetch(`${baseUrl}/openai/v1/models`);

    expect(res.status).toBe(401);
  });
});
