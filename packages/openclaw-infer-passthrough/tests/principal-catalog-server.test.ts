import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { generateKeypair } from '@imajin/auth';
import { loadConfig } from '../src/config.js';
import { createProxyServer } from '../src/server.js';

const principalDid = 'did:imajin:principal';
const jsonRow = (id: string, connector: string, picked = false) => ({
  id, object: 'model', owned_by: connector, created: 1,
  imajin: { connector, credentialDid: principalDid, servable: true, picked },
});
let server: ReturnType<typeof createProxyServer>;
let baseUrl: string;
let realFetch: typeof fetch;

beforeEach(async () => {
  realFetch = globalThis.fetch;
  server = createProxyServer(loadConfig({
    INFER_PROXY_PRINCIPAL_DID: principalDid,
    KERNEL_BASE_URL: 'https://kernel.test',
    OPENCLAW_APP_DID: 'did:imajin:app',
    OPENCLAW_APP_PRIVATE_KEY: generateKeypair().privateKey,
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function stubKernel(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith(baseUrl)) return realFetch(url, init);
    return handler(url, init);
  }));
}

function post(model: string, path = '/openai/v1/chat/completions') {
  return fetch(`${baseUrl}${path}`, { method: 'POST', body: JSON.stringify({ model, messages: [] }) });
}

function mintResponse(init?: RequestInit) {
  const body = JSON.parse(init!.body as string);
  expect(body.principalDid).toBe(principalDid);
  expect(body).not.toHaveProperty('attestationId');
  return Response.json({ token: 'test-token', scopes: ['infer:completions'], expiresIn: 600 });
}

describe('fileless principal + usable catalog HTTP contract (#3041)', () => {
  it('routes unpicked models and newly connected providers after a miss, without changing config or restarting', async () => {
    const initial = jsonRow('arbitrary-model', 'xai', true);
    const added = jsonRow('vendor/new-model', 'openrouter');
    let data = [initial];
    let catalogCalls = 0;
    const forwarded: string[] = [];
    stubKernel((url, init) => {
      if (url.endsWith('/auth/api/apps/token')) return mintResponse(init);
      if (url.endsWith('/infer/v1/models/usable')) {
        catalogCalls++;
        return Response.json({ object: 'list', data });
      }
      expect(url).toBe('https://kernel.test/infer/v1/chat/completions');
      forwarded.push(JSON.parse(init!.body as string).model);
      return Response.json({ id: 'completion' });
    });
    expect((await post(initial.id)).status).toBe(200);
    expect((await post(initial.id, '/v1/chat/completions')).status).toBe(200);
    expect(catalogCalls).toBe(1);
    data = [initial, added];
    expect((await post(added.id)).status).toBe(200);
    expect(catalogCalls).toBe(2);
    expect(forwarded).toEqual([initial.id, initial.id, added.id]);
    const discovery = await fetch(`${baseUrl}/openai/v1/models`);
    expect(await discovery.json()).toEqual({ object: 'list', data });
  });

  it('unknown model after refresh is an OpenAI-shaped 404 naming the /jin connector card', async () => {
    let catalogCalls = 0;
    stubKernel((url, init) => {
      if (url.endsWith('/auth/api/apps/token')) return mintResponse(init);
      expect(url).toBe('https://kernel.test/infer/v1/models/usable');
      catalogCalls++;
      return Response.json({ object: 'list', data: [] });
    });
    const res = await post('missing');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: {
      code: 'no_route_for_model', type: 'invalid_request_error', param: null,
      message: expect.stringContaining('/jin connector card'),
    } });
    expect(catalogCalls).toBe(2);
  });

  it('catalog no_live_grant returns actionable 403, then re-mints after re-grant', async () => {
    let live = false;
    let mints = 0;
    stubKernel((url, init) => {
      if (url.endsWith('/auth/api/apps/token')) {
        mints++;
        return live ? mintResponse(init) : Response.json({ code: 'no_live_grant' }, { status: 403 });
      }
      if (url.endsWith('/infer/v1/models/usable')) return Response.json({ data: [jsonRow('model', 'xai')] });
      return Response.json({ id: 'completion' });
    });
    const first = await post('model');
    expect(first.status).toBe(403);
    expect((await first.json()).error.message).toContain('Re-grant on /jin → Grants');
    live = true;
    expect((await post('model')).status).toBe(200);
    expect(mints).toBe(3); // failed discovery mint, fresh discovery mint, connector mint
  });

  it('catalog outages are 502, not misleading unknown-model 404s', async () => {
    stubKernel((url, init) => url.endsWith('/auth/api/apps/token')
      ? mintResponse(init)
      : Response.json({ error: 'unavailable' }, { status: 503 }));
    const res = await post('model');
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('catalog_unavailable');
  });

  it('scope-denied completion stays a 403 and is not mistaken for revoked consent or retried', async () => {
    let completions = 0;
    stubKernel((url, init) => {
      if (url.endsWith('/auth/api/apps/token')) return mintResponse(init);
      if (url.endsWith('/infer/v1/models/usable')) return Response.json({ data: [jsonRow('model', 'xai')] });
      completions++;
      return Response.json({ error: 'insufficient_scope' }, { status: 403 });
    });
    const res = await post('model');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'insufficient_scope' });
    expect(completions).toBe(1);
  });

  it('missing model on the unprefixed path is 422 without minting', async () => {
    stubKernel(() => { throw new Error('kernel must not be called'); });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(422);
  });
});
