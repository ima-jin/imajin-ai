import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeypair, crypto } from '@imajin/auth';
import { errorToProxyResponse, type ProxyResponse } from '../src/dispatch.js';
import { handleModels } from '../src/handle-models.js';
import { RouteTokenProvider } from '../src/token-provider.js';

const PRINCIPALS = [
  'did:imajin:main-fixture',
  'did:imajin:8gqnAWGGms2cyrZ4krfNQjknYWMfJcoHgnxha8AfKwUY',
];
const APP = 'did:imajin:openclaw-app-fixture';
const BASE = 'https://kernel.test';
const MINT = `${BASE}/auth/api/apps/token`;
const CATALOG = `${BASE}/infer/v1/models/usable`;
const MODEL_LIST = { object: 'list', data: [{ id: 'fixture-anthropic-model', object: 'model' }] };

type Fault = 'network' | 'timeout' | 'malformed' | number;

/** Match server.ts's error boundary without binding an HTTP listener. */
async function withHttpErrorMapping(operation: () => Promise<ProxyResponse>): Promise<ProxyResponse> {
  try {
    return await operation();
  } catch (error) {
    const mapped = errorToProxyResponse(error);
    if (!mapped) throw error;
    return mapped;
  }
}

function injectedResponse(fault: Fault, init: RequestInit): Promise<Response> {
  if (fault === 'network') return Promise.reject(new TypeError('fixture connection refused'));
  if (fault === 'timeout') {
    return new Promise((_resolve, reject) => {
      if (init.signal!.aborted) {
        reject(new Error('fixture aborted'));
        return;
      }
      init.signal!.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true });
    });
  }
  if (fault === 'malformed') return Promise.resolve(Response.json({ expiresIn: 600, scopes: [] }));
  return Promise.resolve(Response.json({ error: fault === 403 ? 'insufficient_scope' : 'fixture upstream failure' }, { status: fault }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(PRINCIPALS)('#3198 discovery failure classification for %s', (principal) => {
  async function runFault(stage: 'mint' | 'catalog', fault: Fault) {
    // Fresh, disposable test signing key only; no live credentials or fixtures from disk.
    const keypair = generateKeypair();
    const provider = new RouteTokenProvider(BASE, APP, keypair.privateKey, principal, undefined, undefined, undefined, undefined, 50);
    const mintBodies: Record<string, unknown>[] = [];
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url);
      if (url === MINT) {
        const body = JSON.parse(init.body as string);
        mintBodies.push(body);
        expect(body.principalDid).toBe(principal);
        expect(body).not.toHaveProperty('attestationId');
        expect(await crypto.verify(
          body.signature, `${APP}:${principal}:${body.nonce}:${body.timestamp}`, keypair.publicKey,
        )).toBe(true);
        if (stage === 'mint') return injectedResponse(fault, init);
        return Response.json({ token: 'fixture-app-token', expiresIn: 600, scopes: ['infer:completions'] });
      }
      expect(url).toBe(CATALOG);
      expect(init.method).toBe('GET');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-app-token');
      return injectedResponse(fault, init);
    }));
    const response = await withHttpErrorMapping(() => handleModels({
      routes: [{ id: 'openai', principalDid: principal }],
      kernelBaseUrl: BASE,
      kernelTimeoutMs: 50,
      getTokenProvider: () => provider,
    }));
    return { response, body: await new Response(response.body).json(), urls, mintBodies };
  }

  it.each([
    ['mint', 'network', 502, 'upstream_unavailable'],
    ['mint', 'timeout', 502, 'upstream_unavailable'],
    ['mint', 500, 502, 'kernel_unavailable'],
    ['mint', 'malformed', 502, 'kernel_unavailable'],
    ['mint', 401, 401, 'unauthorized'],
    ['mint', 403, 401, 'unauthorized'],
    ['catalog', 'network', 502, 'upstream_unavailable'],
    ['catalog', 'timeout', 502, 'upstream_timeout'],
  ] as const)('injected %s %s maps to %s %s (not a live repro)', async (stage, fault, status, error) => {
    const { response, body, urls } = await runFault(stage, fault);
    expect(response.status).toBe(status);
    expect(body.error).toBe(error);
    expect(urls).toEqual(stage === 'mint' ? [MINT] : [MINT, CATALOG]);
  });

  it.each([401, 403, 500, 502, 503, 504])('preserves catalog HTTP %s rather than inventing a principal-specific 502', async (status) => {
    const { response, body, urls, mintBodies } = await runFault('catalog', status);
    expect(response.status).toBe(status);
    expect(body.error).toBe(status === 403 ? 'insufficient_scope' : 'fixture upstream failure');
    expect(urls).toEqual(status === 401 ? [MINT, CATALOG, MINT, CATALOG] : [MINT, CATALOG]);
    expect(mintBodies).toHaveLength(status === 401 ? 2 : 1);
  });

  it('missing live grant is 403, not 502, and never reaches the catalog', async () => {
    const provider = new RouteTokenProvider(BASE, APP, generateKeypair().privateKey, principal);
    const fetchMock = vi.fn(async () => Response.json({ code: 'no_live_grant' }, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await withHttpErrorMapping(() => handleModels({
      kernelBaseUrl: BASE, kernelTimeoutMs: 50, getTokenProvider: () => provider,
    }));
    expect(response.status).toBe(403);
    expect((await new Response(response.body).json()).error.code).toBe('no_live_grant');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('successful discovery mints for this principal and does not 502', async () => {
    const provider = new RouteTokenProvider(BASE, APP, generateKeypair().privateKey, principal);
    const mintPrincipals: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url === MINT) {
        mintPrincipals.push(JSON.parse(init.body as string).principalDid);
        return Response.json({ token: 'fixture-app-token', expiresIn: 600, scopes: ['infer:completions'] });
      }
      expect(url).toBe(CATALOG);
      return Response.json(MODEL_LIST);
    }));
    const response = await handleModels({
      kernelBaseUrl: BASE, kernelTimeoutMs: 50, getTokenProvider: () => provider,
    });
    expect(response.status).toBe(200);
    expect(await new Response(response.body).json()).toEqual(MODEL_LIST);
    expect(mintPrincipals).toEqual([principal]);
  });
});
