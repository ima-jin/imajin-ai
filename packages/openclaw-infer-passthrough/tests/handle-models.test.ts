import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleModels, type HandleModelsDeps } from '../src/handle-models.js';
import { bodyToText, fakeTokenSource } from './dispatch-test-support.js';

function baseDeps(overrides: Partial<HandleModelsDeps> = {}): HandleModelsDeps {
  return {
    kernelBaseUrl: 'https://kernel.test',
    kernelTimeoutMs: 5_000,
    getTokenProvider: () => fakeTokenSource(['tok-1']),
    ...overrides,
  };
}

const MODELS_BODY = JSON.stringify({
  object: 'list',
  data: [{ id: 'grok-4', object: 'model', owned_by: 'xai', created: 1_700_000_000, imajin: { connector: 'xai', credentialDid: 'did:imajin:x', servable: true } }],
});

describe('handleModels — GET /openai/v1/models passthrough (imajin-ai#2201)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('mints exactly one token and forwards the kernel body unchanged on success', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://kernel.test/infer/v1/models/usable');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
      expect(init?.method).toBe('GET');
      return new Response(MODELS_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tokenSource = fakeTokenSource(['tok-1']);
    const result = await handleModels(baseDeps({ getTokenProvider: () => tokenSource }));

    expect(result.status).toBe(200);
    expect(await bodyToText(result.body)).toBe(MODELS_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenSource.calls).toBe(1);
  });

  it('forwards a non-200 kernel status (e.g. 422 no_brain) verbatim', async () => {
    const errorBody = JSON.stringify({ error: 'no_brain', message: 'No AI model connected' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(errorBody, { status: 422, headers: { 'Content-Type': 'application/json' } })));

    const result = await handleModels(baseDeps());

    expect(result.status).toBe(422);
    expect(await bodyToText(result.body)).toBe(errorBody);
  });

  it('retries once with a freshly-minted token on a 401', async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      call += 1;
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (call === 1) {
        expect(auth).toBe('Bearer tok-expired');
        return new Response(JSON.stringify({ error: 'invalid token' }), { status: 401 });
      }
      expect(auth).toBe('Bearer tok-fresh');
      return new Response(MODELS_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tokenSource = fakeTokenSource(['tok-expired', 'tok-fresh']);
    const result = await handleModels(baseDeps({ getTokenProvider: () => tokenSource }));

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a persistent 401 after one retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid token' }), { status: 401 })));

    const result = await handleModels(baseDeps({ getTokenProvider: () => fakeTokenSource(['tok-1', 'tok-2']) }));

    expect(result.status).toBe(401);
  });
});
