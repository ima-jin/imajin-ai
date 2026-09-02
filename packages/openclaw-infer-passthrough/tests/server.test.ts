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
  routes: [{ id: 'xai', principalDid: 'did:imajin:ryan', attestationId: 'att-xai', modelPrefixes: ['grok-'] }],
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

  it('returns 422 for an unrecognised provider path segment', async () => {
    const res = await fetch(`${baseUrl}/not-configured/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(422);
  });
});
