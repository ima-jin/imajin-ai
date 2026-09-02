import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleAnthropicRequest, type HandleAnthropicDeps } from '../src/anthropic-handler.js';
import { HealthTracker } from '../src/health.js';
import { createLogger } from '../src/logger.js';
import type { ProviderRouteConfig } from '../src/types.js';
import { bodyToText, fakeTokenSource, onAbortRejection } from './dispatch-test-support.js';

const ANTHROPIC_ROUTE: ProviderRouteConfig = {
  id: 'anthropic',
  principalDid: 'did:imajin:ryan',
  attestationId: 'att-anthropic',
  modelPrefixes: ['claude-'],
  directBaseUrl: 'https://api.anthropic.example/v1',
  directApiKeyEnvVar: 'ANTHROPIC_DIRECT_API_KEY',
};

const ANTHROPIC_ROUTE_NO_FALLBACK: ProviderRouteConfig = {
  id: 'anthropic',
  principalDid: 'did:imajin:ryan',
  attestationId: 'att-anthropic',
};

function baseDeps(overrides: Partial<HandleAnthropicDeps> = {}): HandleAnthropicDeps {
  return {
    route: ANTHROPIC_ROUTE,
    kernelBaseUrl: 'https://kernel.test',
    kernelTimeoutMs: 5_000,
    directTimeoutMs: 5_000,
    getTokenProvider: () => fakeTokenSource(['tok-1']),
    resolveDirectApiKey: () => 'direct-anthropic-key',
    health: new HealthTracker(),
    log: createLogger('test'),
    ...overrides,
  };
}

describe('handleAnthropicRequest — happy path', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('forwards a POST /anthropic/v1/messages call to the kernel with x-api-key auth', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://kernel.test/infer/v1/messages');
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('tok-1');
      expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
      return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps();
    const result = await handleAnthropicRequest(deps, { endpoint: 'messages', bodyText: '{"messages":[]}' });

    expect(result.status).toBe(200);
    expect(await bodyToText(result.body)).toBe(JSON.stringify({ id: 'msg_1' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forwards a POST /anthropic/v1/messages/count_tokens call to the kernel count_tokens route', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://kernel.test/infer/v1/messages/count_tokens');
      return new Response(JSON.stringify({ input_tokens: 14 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps();
    const result = await handleAnthropicRequest(deps, { endpoint: 'count_tokens', bodyText: '{"messages":[]}' });

    expect(result.status).toBe(200);
    expect(await bodyToText(result.body)).toBe(JSON.stringify({ input_tokens: 14 }));
  });

  it('forwards the anthropic-version/anthropic-beta headers unchanged', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['anthropic-version']).toBe('2024-06-01');
      expect(headers['anthropic-beta']).toBe('context-management-2025-06-27');
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps();
    await handleAnthropicRequest(deps, {
      endpoint: 'messages',
      bodyText: '{}',
      anthropicVersion: '2024-06-01',
      anthropicBeta: 'context-management-2025-06-27',
    });
  });

  it('streams an SSE response through untouched, byte for byte', async () => {
    const sseChunks = ['event: message_start\ndata: {}\n\n', 'event: message_stop\ndata: {}\n\n'];
    const upstreamStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of sseChunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(upstreamStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })));

    const deps = baseDeps();
    const result = await handleAnthropicRequest(deps, { endpoint: 'messages', bodyText: JSON.stringify({ stream: true, messages: [] }) });

    expect(result.status).toBe(200);
    expect(result.headers['Content-Type']).toBe('text/event-stream');
    expect(await bodyToText(result.body)).toBe(sseChunks.join(''));
  });

  it('returns 422 no_route_configured when no anthropic route is set up', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps({ route: undefined });
    const result = await handleAnthropicRequest(deps, { endpoint: 'messages', bodyText: '{}' });

    expect(result.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('handleAnthropicRequest — 4xx is surfaced verbatim, never triggers fallback', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('forwards a 422 no_model_selected error without attempting fallback', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'no_model_selected' }), { status: 422 }));
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps();
    const result = await handleAnthropicRequest(deps, { endpoint: 'messages', bodyText: '{}' });

    expect(result.status).toBe(422);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deps.health.snapshot().fallbackCount).toBe(0);
  });
});

describe('handleAnthropicRequest — 401 retries once with a fresh token', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reminting after a 401 succeeds on the second attempt', async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      call += 1;
      const apiKey = (init?.headers as Record<string, string>)['x-api-key'];
      if (call === 1) {
        expect(apiKey).toBe('tok-expired');
        return new Response(JSON.stringify({ error: 'invalid token' }), { status: 401 });
      }
      expect(apiKey).toBe('tok-fresh');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tokenSource = fakeTokenSource(['tok-expired', 'tok-fresh']);
    const deps = baseDeps({ getTokenProvider: () => tokenSource });
    const result = await handleAnthropicRequest(deps, { endpoint: 'messages', bodyText: '{}' });

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('handleAnthropicRequest — 5xx/timeout triggers break-glass fallback', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to the direct Anthropic endpoint on a kernel 502, using x-api-key auth', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('kernel.test')) {
        return new Response(JSON.stringify({ error: 'bad_gateway' }), { status: 502 });
      }
      expect(url).toBe('https://api.anthropic.example/v1/messages');
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('direct-anthropic-key');
      return new Response(JSON.stringify({ ok: 'direct' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps();
    const result = await handleAnthropicRequest(deps, { endpoint: 'messages', bodyText: JSON.stringify({ messages: [] }) });

    expect(result.status).toBe(200);
    expect(await bodyToText(result.body)).toBe(JSON.stringify({ ok: 'direct' }));
    const snapshot = deps.health.snapshot();
    expect(snapshot.fallbackCount).toBe(1);
    expect(snapshot.fallbackRate).toBe(1);
  });

  it('falls back to the direct count_tokens endpoint on a kernel timeout', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('kernel.test')) {
        return onAbortRejection(init?.signal as AbortSignal);
      }
      expect(url).toBe('https://api.anthropic.example/v1/messages/count_tokens');
      return new Response(JSON.stringify({ input_tokens: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps({ kernelTimeoutMs: 5 });
    const result = await handleAnthropicRequest(deps, { endpoint: 'count_tokens', bodyText: '{}' });

    expect(result.status).toBe(200);
    expect(deps.health.snapshot().fallbackCount).toBe(1);
  });

  it('never falls back on a kernel 4xx, even with a break-glass endpoint configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })));

    const deps = baseDeps();
    const result = await handleAnthropicRequest(deps, { endpoint: 'messages', bodyText: '{}' });

    expect(result.status).toBe(403);
    expect(deps.health.snapshot().fallbackCount).toBe(0);
  });

  it('surfaces the kernel error when no break-glass endpoint is configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));

    const deps = baseDeps({ route: ANTHROPIC_ROUTE_NO_FALLBACK });
    const result = await handleAnthropicRequest(deps, { endpoint: 'messages', bodyText: '{}' });

    expect(result.status).toBe(502);
    expect(await bodyToText(result.body)).toContain('kernel_unavailable');
    expect(deps.health.snapshot().fallbackCount).toBe(0);
  });

  it('reports fallback_failed (502) when the direct leg itself throws', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('kernel.test')) return new Response('boom', { status: 500 });
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps();
    const result = await handleAnthropicRequest(deps, { endpoint: 'messages', bodyText: '{}' });

    expect(result.status).toBe(502);
    expect(await bodyToText(result.body)).toContain('fallback_failed');
    expect(deps.health.snapshot().fallbackCount).toBe(1);
  });
});
