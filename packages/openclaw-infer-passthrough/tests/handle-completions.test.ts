import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleCompletions, type HandleCompletionsDeps } from '../src/handle-completions.js';
import { HealthTracker } from '../src/health.js';
import { createLogger } from '../src/logger.js';
import type { TokenSource } from '../src/token-provider.js';
import type { ProviderRouteConfig } from '../src/types.js';

const ROUTE_NO_FALLBACK: ProviderRouteConfig = {
  id: 'xai',
  principalDid: 'did:imajin:ryan',
  attestationId: 'att-xai',
  modelPrefixes: ['grok-'],
};

const ROUTE_WITH_FALLBACK: ProviderRouteConfig = {
  id: 'anthropic',
  principalDid: 'did:imajin:ryan',
  attestationId: 'att-anthropic',
  modelPrefixes: ['claude-'],
  directBaseUrl: 'https://api.anthropic.example/v1',
  directApiKeyEnvVar: 'ANTHROPIC_DIRECT_API_KEY',
};

function fakeTokenSource(tokens: string[]): TokenSource & { calls: number } {
  let i = 0;
  return {
    calls: 0,
    async getToken() {
      this.calls += 1;
      return tokens[Math.min(i, tokens.length - 1)];
    },
    invalidate() {
      i += 1;
    },
  };
}

function baseDeps(overrides: Partial<HandleCompletionsDeps> = {}): HandleCompletionsDeps {
  return {
    routes: [ROUTE_NO_FALLBACK, ROUTE_WITH_FALLBACK],
    kernelBaseUrl: 'https://kernel.test',
    kernelTimeoutMs: 5_000,
    directTimeoutMs: 5_000,
    getTokenProvider: () => fakeTokenSource(['tok-1']),
    resolveDirectApiKey: () => 'direct-key',
    health: new HealthTracker(),
    log: createLogger('test'),
    ...overrides,
  };
}

async function bodyToText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  return new Response(body).text();
}

function onAbortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      reject(err);
    });
  });
}

describe('handleCompletions — happy path', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('forwards a non-streaming request and returns the kernel body/status untouched', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://kernel.test/infer/v1/chat/completions');
      return new Response(JSON.stringify({ id: 'chatcmpl-1', choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps();
    const result = await handleCompletions(deps, {
      providerIdFromPath: 'xai',
      bodyText: JSON.stringify({ model: 'grok-4', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(result.status).toBe(200);
    expect(await bodyToText(result.body)).toBe(JSON.stringify({ id: 'chatcmpl-1', choices: [] }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok-1' });
  });

  it('streams an SSE response through untouched, byte for byte', async () => {
    const sseChunks = ['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n', 'data: [DONE]\n\n'];
    const upstreamStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of sseChunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(upstreamStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })),
    );

    const deps = baseDeps();
    const result = await handleCompletions(deps, {
      providerIdFromPath: 'xai',
      bodyText: JSON.stringify({ model: 'grok-4', stream: true, messages: [] }),
    });

    expect(result.status).toBe(200);
    expect(result.headers['Content-Type']).toBe('text/event-stream');
    expect(await bodyToText(result.body)).toBe(sseChunks.join(''));
  });

  it('resolves the route from body.model on the unprefixed path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    );
    const deps = baseDeps();
    const result = await handleCompletions(deps, { bodyText: JSON.stringify({ model: 'grok-4-fast', messages: [] }) });
    expect(result.status).toBe(200);
  });
});

describe('handleCompletions — 4xx is surfaced verbatim, never triggers fallback', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('forwards a 422 NoModelSelected-style error without attempting fallback', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'no_model_selected' }), { status: 422 }));
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps({ routes: [ROUTE_WITH_FALLBACK] });
    const result = await handleCompletions(deps, { providerIdFromPath: 'anthropic', bodyText: JSON.stringify({ messages: [] }) });

    expect(result.status).toBe(422);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the kernel call — no direct fallback attempted
    expect(deps.health.snapshot().fallbackCount).toBe(0);
  });

  it('forwards a 403 scope error verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })));
    const deps = baseDeps({ routes: [ROUTE_WITH_FALLBACK] });
    const result = await handleCompletions(deps, { providerIdFromPath: 'anthropic', bodyText: '{}' });
    expect(result.status).toBe(403);
    expect(deps.health.snapshot().fallbackCount).toBe(0);
  });

  it('returns 422 no_route_for_model without calling the network when no route matches', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const deps = baseDeps();
    const result = await handleCompletions(deps, { bodyText: JSON.stringify({ model: 'unknown-model-xyz' }) });
    expect(result.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('handleCompletions — 401 retries once with a fresh token', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reminting after a 401 succeeds on the second attempt', async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      call += 1;
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (call === 1) {
        expect(auth).toBe('Bearer tok-expired');
        return new Response(JSON.stringify({ error: 'invalid token' }), { status: 401 });
      }
      expect(auth).toBe('Bearer tok-fresh');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tokenSource = fakeTokenSource(['tok-expired', 'tok-fresh']);
    const deps = baseDeps({ routes: [ROUTE_NO_FALLBACK], getTokenProvider: () => tokenSource });
    const result = await handleCompletions(deps, { providerIdFromPath: 'xai', bodyText: '{}' });

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a persistent 401 (after one retry) as a final client error, not a fallback trigger', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid token' }), { status: 401 })));
    const deps = baseDeps({ routes: [ROUTE_WITH_FALLBACK] });
    const result = await handleCompletions(deps, { providerIdFromPath: 'anthropic', bodyText: '{}' });
    expect(result.status).toBe(401);
    expect(deps.health.snapshot().fallbackCount).toBe(0);
  });
});

describe('handleCompletions — 5xx/timeout triggers break-glass fallback', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to the direct provider on a kernel 502 and increments fallback counters', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('kernel.test')) {
        return new Response(JSON.stringify({ error: 'bad_gateway' }), { status: 502 });
      }
      expect(url).toBe('https://api.anthropic.example/v1/chat/completions');
      return new Response(JSON.stringify({ ok: 'direct' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps({ routes: [ROUTE_WITH_FALLBACK] });
    const result = await handleCompletions(deps, {
      providerIdFromPath: 'anthropic',
      bodyText: JSON.stringify({ model: 'claude-4', messages: [] }),
    });

    expect(result.status).toBe(200);
    expect(await bodyToText(result.body)).toBe(JSON.stringify({ ok: 'direct' }));
    const snapshot = deps.health.snapshot();
    expect(snapshot.fallbackCount).toBe(1);
    expect(snapshot.kernelOk).toBe(false);
    expect(snapshot.fallbackRate).toBe(1);
    expect(snapshot.lastFallbackAt).not.toBeNull();
  });

  it('falls back on a kernel time-to-first-byte timeout', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('kernel.test')) {
        return onAbortRejection(init?.signal as AbortSignal);
      }
      return new Response(JSON.stringify({ ok: 'direct' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps({ routes: [ROUTE_WITH_FALLBACK], kernelTimeoutMs: 5 });
    const result = await handleCompletions(deps, { providerIdFromPath: 'anthropic', bodyText: '{}' });

    expect(result.status).toBe(200);
    expect(deps.health.snapshot().fallbackCount).toBe(1);
  });

  it('surfaces the kernel error when no break-glass endpoint is configured for the route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
    const deps = baseDeps({ routes: [ROUTE_NO_FALLBACK] });
    const result = await handleCompletions(deps, { providerIdFromPath: 'xai', bodyText: '{}' });

    expect(result.status).toBe(502);
    expect(await bodyToText(result.body)).toContain('kernel_unavailable');
    expect(deps.health.snapshot().fallbackCount).toBe(0);
  });

  it('counts a fallback attempt even when the direct provider also returns an error status', async () => {
    // Both legs return 500 here. A direct-provider HTTP error response is still
    // a completed fallback attempt (the direct leg answered), distinct from the
    // network-level failure case covered below — so it counts and is forwarded.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const deps = baseDeps({ routes: [ROUTE_WITH_FALLBACK] });
    const result = await handleCompletions(deps, { providerIdFromPath: 'anthropic', bodyText: '{}' });

    expect(result.status).toBe(500);
    expect(deps.health.snapshot().fallbackCount).toBe(1);
  });

  it('reports fallback_failed (502) when the direct leg itself throws', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('kernel.test')) return new Response('boom', { status: 500 });
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps({ routes: [ROUTE_WITH_FALLBACK] });
    const result = await handleCompletions(deps, { providerIdFromPath: 'anthropic', bodyText: '{}' });

    expect(result.status).toBe(502);
    expect(await bodyToText(result.body)).toContain('fallback_failed');
    expect(deps.health.snapshot().fallbackCount).toBe(1);
  });

  it('does not attempt fallback when the route has a directBaseUrl but no resolvable API key', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps({ routes: [ROUTE_WITH_FALLBACK], resolveDirectApiKey: () => undefined });
    const result = await handleCompletions(deps, { providerIdFromPath: 'anthropic', bodyText: '{}' });

    expect(result.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1); // kernel only
    expect(deps.health.snapshot().fallbackCount).toBe(0);
  });
});
