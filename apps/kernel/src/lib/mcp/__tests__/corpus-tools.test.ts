/**
 * Tests for the corpus MCP proxy tools (#1730).
 *
 * These tools are thin proxies to the out-of-process corpus service
 * (apps/corpus): no indexing/search logic lives in the kernel, so what is
 * worth testing here is the auth-gate + proxy contract itself —
 *   - the acting DID (`ctx.did`) is used as the `:did` path parameter, never
 *     anything from tool arguments, so one DID can never reach another's
 *     corpus;
 *   - `corpus:read` / `corpus:write` are enforced per-tool through the same
 *     gate every other MCP tool uses (server.ts `requiredScope`);
 *   - the HTTP call shape (method, URL, body) matches apps/corpus/src/routes.ts.
 *
 * `fetch` is mocked throughout — the corpus service is never actually called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { McpContent, McpToolContext } from '../types';

// Swap the registry for the real corpus tools only, so the scope gate in
// server.ts runs against them without loading every other (DB-backed) tool
// module (same technique as inference-tools.test.ts).
vi.mock('../tools', async () => {
  const { corpusTools } = await import('../tools/corpus');
  const byName = new Map(corpusTools.map((t) => [t.name, t]));
  return { ALL_TOOLS: corpusTools, toolByName: (n: string) => byName.get(n) };
});

const mockResolveGrant = vi.hoisted(() => vi.fn<(did: string, scope: string) => Promise<boolean>>());
vi.mock('../mcp-grant', () => ({
  resolveActiveMcpGrant: (...args: [string, string]) => mockResolveGrant(...args),
}));

import { handleMcpRpc } from '../server';
import { corpusTools } from '../tools/corpus';

const ORIGINAL_ENV = process.env.CORPUS_SERVICE_URL;

function tool(name: string) {
  const t = corpusTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

function ctxFor(did: string, scopes: string[]): McpToolContext {
  return { did, appDid: 'did:imajin:mcp-connector', scopes: new Set(scopes) };
}

async function call(name: string, args: Record<string, unknown>, ctx: McpToolContext): Promise<McpContent[]> {
  return (await tool(name).handler(args, ctx)) as McpContent[];
}

function parseResult(content: McpContent[]) {
  return JSON.parse(content[0].text);
}

/** Gate-level call, through the real handleMcpRpc dispatch + scope check. */
function callViaGate(name: string, scopes: string[]) {
  const ctx = ctxFor('did:imajin:user', scopes);
  return handleMcpRpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
    ctx,
  ) as Promise<any>;
}

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  };
}

beforeEach(() => {
  mockResolveGrant.mockReset();
  mockResolveGrant.mockResolvedValue(false);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  delete process.env.CORPUS_SERVICE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_ENV === undefined) delete process.env.CORPUS_SERVICE_URL;
  else process.env.CORPUS_SERVICE_URL = ORIGINAL_ENV;
});

// ─── Registration ────────────────────────────────────────────────────────────

describe('corpus tool registration', () => {
  it('exports search, load, sync, and status', () => {
    expect(corpusTools.map((t) => t.name)).toEqual([
      'corpus_search',
      'corpus_load',
      'corpus_sync',
      'corpus_status',
    ]);
  });

  it('gates read tools on corpus:read and write tools on corpus:write', () => {
    expect(tool('corpus_search').requiredScope).toBe('corpus:read');
    expect(tool('corpus_status').requiredScope).toBe('corpus:read');
    expect(tool('corpus_load').requiredScope).toBe('corpus:write');
    expect(tool('corpus_sync').requiredScope).toBe('corpus:write');
  });
});

// ─── corpus_search ───────────────────────────────────────────────────────────

describe('corpus_search', () => {
  it('resolves the acting DID and proxies to POST /corpus/:did/search', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { results: [], totalHits: 0, freshness: [], tokensUsed: 0 }),
    );

    const ctx = ctxFor('did:imajin:alice', ['corpus:read']);
    const out = parseResult(await call('corpus_search', { query: 'flaky test' }, ctx));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8003/corpus/did%3Aimajin%3Aalice/search');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ query: 'flaky test' });
    expect(out).toEqual({ results: [], totalHits: 0, freshness: [], tokensUsed: 0 });
  });

  it('forwards optional filters only when provided', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], totalHits: 0, freshness: [], tokensUsed: 0 }));

    await call(
      'corpus_search',
      {
        query: 'auth bug',
        sourceType: 'github',
        state: ['open', 'draft'],
        labels: ['bug'],
        limit: 5,
      },
      ctxFor('did:imajin:alice', ['corpus:read']),
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      query: 'auth bug',
      sourceType: 'github',
      state: ['open', 'draft'],
      labels: ['bug'],
      limit: 5,
    });
  });

  it('requires a query', async () => {
    await expect(
      call('corpus_search', {}, ctxFor('did:imajin:alice', ['corpus:read'])),
    ).rejects.toThrow('query is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a different caller\u2019s own DID in the path, never a shared or cross-DID value', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], totalHits: 0, freshness: [], tokensUsed: 0 }));

    await call('corpus_search', { query: 'x' }, ctxFor('did:imajin:bob', ['corpus:read']));

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain(encodeURIComponent('did:imajin:bob'));
    expect(url).not.toContain('alice');
  });

  it('surfaces a non-2xx corpus response as a thrown error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: 'query is required' }));

    await expect(
      call('corpus_search', { query: 'x' }, ctxFor('did:imajin:alice', ['corpus:read'])),
    ).rejects.toThrow(/corpus_service_error: 400/);
  });

  it('honours CORPUS_SERVICE_URL when set', async () => {
    process.env.CORPUS_SERVICE_URL = 'http://corpus.internal:9000';
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], totalHits: 0, freshness: [], tokensUsed: 0 }));

    await call('corpus_search', { query: 'x' }, ctxFor('did:imajin:alice', ['corpus:read']));

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://corpus.internal:9000/corpus/did%3Aimajin%3Aalice/search');
  });
});

// ─── corpus_load ─────────────────────────────────────────────────────────────

describe('corpus_load', () => {
  it('proxies to POST /corpus/:did/ingest with the documents array as the body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ingested: 2 }));

    const documents = [
      { source: 'github:ima-jin/imajin-ai', id: '1' },
      { source: 'github:ima-jin/imajin-ai', id: '2' },
    ];
    const out = parseResult(
      await call(
        'corpus_load',
        { source: 'github:ima-jin/imajin-ai', documents },
        ctxFor('did:imajin:alice', ['corpus:write']),
      ),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8003/corpus/did%3Aimajin%3Aalice/ingest');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(documents);
    expect(out).toEqual({ ingested: 2 });
  });

  it('requires source and a documents array', async () => {
    const ctx = ctxFor('did:imajin:alice', ['corpus:write']);
    await expect(call('corpus_load', { documents: [] }, ctx)).rejects.toThrow('source is required');
    await expect(call('corpus_load', { source: 'x' }, ctx)).rejects.toThrow('documents must be an array');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── corpus_sync ─────────────────────────────────────────────────────────────

describe('corpus_sync', () => {
  it('proxies to POST /corpus/:did/sync', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { synced: true }));

    await call('corpus_sync', { source: 'github:ima-jin/imajin-ai' }, ctxFor('did:imajin:alice', ['corpus:write']));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8003/corpus/did%3Aimajin%3Aalice/sync');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ source: 'github:ima-jin/imajin-ai' });
  });

  it('registers even though the backend currently answers 501', async () => {
    fetchMock.mockResolvedValue(jsonResponse(501, { error: 'sync is not implemented in v1' }));

    await expect(call('corpus_sync', {}, ctxFor('did:imajin:alice', ['corpus:write']))).rejects.toThrow(
      /corpus_service_error: 501/,
    );
  });
});

// ─── corpus_status ───────────────────────────────────────────────────────────

describe('corpus_status', () => {
  it('takes no arguments and proxies to GET /corpus/:did/status', async () => {
    const freshness = [{ source: 'github:ima-jin/imajin-ai', lastSync: '2026-01-01T00:00:00.000Z', threadCount: 42 }];
    fetchMock.mockResolvedValue(jsonResponse(200, { sources: freshness, threadCount: 42 }));

    const out = parseResult(await call('corpus_status', {}, ctxFor('did:imajin:alice', ['corpus:read'])));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8003/corpus/did%3Aimajin%3Aalice/status');
    expect(init.method).toBe('GET');
    expect(out).toEqual({ sources: freshness, threadCount: 42 });
  });
});

// ─── The scope gate ──────────────────────────────────────────────────────────

describe('scope gate', () => {
  it('denies corpus_search to a token without corpus:read', async () => {
    const res = await callViaGate('corpus_search', ['corpus:write']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(res.result.content[0].text).toContain('corpus:read');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('denies corpus_status to a token without corpus:read', async () => {
    const res = await callViaGate('corpus_status', []);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('denies corpus_load and corpus_sync to a token without corpus:write', async () => {
    for (const name of ['corpus_load', 'corpus_sync']) {
      const res = await callViaGate(name, ['corpus:read']);
      expect(res.result.isError, name).toBe(true);
      expect(res.result.content[0].text, name).toContain('insufficient_scope');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets a corpus:read token reach the corpus_search handler', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], totalHits: 0, freshness: [], tokensUsed: 0 }));
    const res = await callViaGate('corpus_search', ['corpus:read']);
    // The gate passed the arg-less call through to the handler, which fails on
    // its own required argument — proof the gate, not the handler, isn't what
    // rejected it.
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).not.toContain('insufficient_scope');
    expect(res.result.content[0].text).toContain('query is required');
  });
});
