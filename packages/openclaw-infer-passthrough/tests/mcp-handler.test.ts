import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleMcpRequest, type HandleMcpDeps } from '../src/mcp-handler.js';
import { HealthTracker } from '../src/health.js';
import { createLogger } from '../src/logger.js';
import type { ProviderRouteConfig } from '../src/types.js';
import { bodyToText, fakeScopedTokenSource, onAbortRejection } from './dispatch-test-support.js';

const MCP_ROUTE: ProviderRouteConfig = {
  id: 'mcp',
  principalDid: 'did:imajin:ryan',
  attestationId: 'att-mcp',
};

function baseDeps(overrides: Partial<HandleMcpDeps> = {}): HandleMcpDeps {
  return {
    route: MCP_ROUTE,
    appDid: 'did:imajin:openclaw-app',
    kernelBaseUrl: 'https://kernel.test',
    kernelTimeoutMs: 5_000,
    getTokenProvider: () => fakeScopedTokenSource(['tok-1'], ['media:read']),
    resolveDirectApiKey: () => undefined,
    health: new HealthTracker(),
    log: createLogger('test'),
    ...overrides,
  };
}

describe('handleMcpRequest — happy path', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('forwards a JSON-RPC POST /mcp call to the kernel with Bearer auth', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://kernel.test/mcp');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps();
    const result = await handleMcpRequest(deps, { bodyText: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });

    expect(result.status).toBe(200);
    expect(await bodyToText(result.body)).toBe(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves Mcp-Session-Id/Mcp-Protocol-Version in both directions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        expect(headers['Mcp-Session-Id']).toBe('sess-abc');
        expect(headers['Mcp-Protocol-Version']).toBe('2026-07-28');
        return new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-abc', 'Mcp-Protocol-Version': '2026-07-28' },
        });
      }),
    );

    const deps = baseDeps();
    const result = await handleMcpRequest(deps, { bodyText: '{}', mcpSessionId: 'sess-abc', mcpProtocolVersion: '2026-07-28' });

    expect(result.headers['Mcp-Session-Id']).toBe('sess-abc');
    expect(result.headers['Mcp-Protocol-Version']).toBe('2026-07-28');
  });

  it('streams an SSE response through untouched', async () => {
    const sseChunks = ['event: message\ndata: {}\n\n'];
    const upstreamStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of sseChunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(upstreamStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })));

    const deps = baseDeps();
    const result = await handleMcpRequest(deps, { bodyText: '{}' });

    expect(result.status).toBe(200);
    expect(result.headers['Content-Type']).toBe('text/event-stream');
    expect(await bodyToText(result.body)).toBe(sseChunks.join(''));
  });

  it('returns 422 no_route_configured when no mcp route is set up', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps({ route: undefined });
    const result = await handleMcpRequest(deps, { bodyText: '{}' });

    expect(result.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('handleMcpRequest — X-Imajin-App-Did (single-identity case)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts a matching X-Imajin-App-Did header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    const deps = baseDeps();
    const result = await handleMcpRequest(deps, { bodyText: '{}', appDidHeader: 'did:imajin:openclaw-app' });

    expect(result.status).toBe(200);
  });

  it('rejects a mismatched X-Imajin-App-Did header with 400', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps();
    const result = await handleMcpRequest(deps, { bodyText: '{}', appDidHeader: 'did:imajin:someone-else' });

    expect(result.status).toBe(400);
    expect(await bodyToText(result.body)).toContain('app_did_mismatch');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('handleMcpRequest — scope gate', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns 403 insufficient_scope when the minted token carries no MCP-surface scope', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const deps = baseDeps({ getTokenProvider: () => fakeScopedTokenSource(['tok-1'], ['infer:completions']) });
    const result = await handleMcpRequest(deps, { bodyText: '{}' });

    expect(result.status).toBe(403);
    expect(await bodyToText(result.body)).toContain('insufficient_scope');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards when the token carries at least one recognized MCP scope, even alongside unrelated scopes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    const deps = baseDeps({ getTokenProvider: () => fakeScopedTokenSource(['tok-1'], ['infer:completions', 'github:read']) });
    const result = await handleMcpRequest(deps, { bodyText: '{}' });

    expect(result.status).toBe(200);
  });

  it('returns 403 attestation_rejected when minting itself fails (e.g. a revoked attestation)', async () => {
    const brokenTokenSource = {
      async getToken(): Promise<string> {
        throw new Error('Failed to mint app token: 403 Authorization has been revoked');
      },
      invalidate(): void {},
      async getScopes(): Promise<string[]> {
        throw new Error('Failed to mint app token: 403 Authorization has been revoked');
      },
    };

    const deps = baseDeps({ getTokenProvider: () => brokenTokenSource });
    const result = await handleMcpRequest(deps, { bodyText: '{}' });

    expect(result.status).toBe(403);
    expect(await bodyToText(result.body)).toContain('attestation_rejected');
  });
});

describe('handleMcpRequest — 401 retries once with a fresh token', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reminting after a 401 succeeds on the second attempt', async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      call += 1;
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (call === 1) {
        expect(auth).toBe('Bearer tok-expired');
        return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 });
      }
      expect(auth).toBe('Bearer tok-fresh');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tokenSource = fakeScopedTokenSource(['tok-expired', 'tok-fresh'], ['media:read']);
    const deps = baseDeps({ getTokenProvider: () => tokenSource });
    const result = await handleMcpRequest(deps, { bodyText: '{}' });

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('handleMcpRequest — no break-glass fallback exists for MCP', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('surfaces a 502 kernel_unavailable on a kernel 5xx, never attempting a direct fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));

    const deps = baseDeps();
    const result = await handleMcpRequest(deps, { bodyText: '{}' });

    expect(result.status).toBe(502);
    expect(await bodyToText(result.body)).toContain('kernel_unavailable');
    expect(deps.health.snapshot().fallbackCount).toBe(0);
  });

  it('surfaces a 502 on a kernel timeout, never attempting a direct fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => onAbortRejection(init?.signal as AbortSignal)),
    );

    const deps = baseDeps({ kernelTimeoutMs: 5 });
    const result = await handleMcpRequest(deps, { bodyText: '{}' });

    expect(result.status).toBe(502);
    expect(deps.health.snapshot().fallbackCount).toBe(0);
  });

  it('never falls back on a kernel 4xx, forwarding it verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })));

    const deps = baseDeps();
    const result = await handleMcpRequest(deps, { bodyText: '{}' });

    expect(result.status).toBe(403);
    expect(deps.health.snapshot().fallbackCount).toBe(0);
  });
});
