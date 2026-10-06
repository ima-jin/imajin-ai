import { describe, expect, it, vi } from 'vitest';
import { PgxNotConfiguredError, PgxUnavailableError } from '../../engine/errors';
import { PgxClient, type FetchLike } from '../pgx-client';

const EMBED_URL = 'http://pgx.test:8001';
const RERANK_URL = 'http://pgx.test:8002';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function parseBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('PgxClient — never touches the network (fetchImpl is always injected)', () => {
  it('reports isConfigured()/hasRerank() based on the URLs given', () => {
    expect(new PgxClient({}).isConfigured()).toBe(false);
    expect(new PgxClient({}).hasRerank()).toBe(false);
    expect(new PgxClient({ embedUrl: EMBED_URL }).isConfigured()).toBe(true);
    expect(new PgxClient({ rerankUrl: RERANK_URL }).hasRerank()).toBe(true);
  });

  it('embed() throws PgxNotConfiguredError when no embed URL is set', async () => {
    const client = new PgxClient({});
    await expect(client.embed(['hello'])).rejects.toThrow(PgxNotConfiguredError);
  });

  it('rerank() throws PgxNotConfiguredError when no rerank URL is set', async () => {
    const client = new PgxClient({});
    await expect(client.rerank('q', ['doc'])).rejects.toThrow(PgxNotConfiguredError);
  });

  it('embed() posts to /v1/embeddings with the bge-m3 model and returns vectors in input order', async () => {
    const fetchImpl: FetchLike = vi.fn(async (url, init) => {
      expect(url).toBe(`${EMBED_URL}/v1/embeddings`);
      const body = parseBody(init);
      expect(body.model).toBe('bge-m3');
      const input = body.input as string[];
      // Respond out of order to prove the client re-sorts by `index`.
      return jsonResponse({
        data: input.map((_text, index) => ({ index, embedding: [index] })).reverse(),
      });
    });

    const client = new PgxClient({ embedUrl: EMBED_URL, fetchImpl });
    const vectors = await client.embed(['a', 'b', 'c']);

    expect(vectors).toEqual([[0], [1], [2]]);
  });

  it('embed() chunks large input arrays into batchSize-sized requests', async () => {
    const requestSizes: number[] = [];
    const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
      const input = parseBody(init).input as string[];
      requestSizes.push(input.length);
      return jsonResponse({ data: input.map((_text, index) => ({ index, embedding: [index] })) });
    });

    const client = new PgxClient({ embedUrl: EMBED_URL, fetchImpl, batchSize: 2 });
    const vectors = await client.embed(['a', 'b', 'c', 'd', 'e']);

    expect(requestSizes).toEqual([2, 2, 1]);
    expect(vectors).toHaveLength(5);
  });

  it('embed() sends batches one at a time, in order, and stops at the first failing batch', async () => {
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
      const input = parseBody(init).input as string[];
      started.push(input.join(''));
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      if (input.includes('c')) return jsonResponse({ error: 'overloaded' }, 503);
      return jsonResponse({ data: input.map((_text, index) => ({ index, embedding: [index] })) });
    });

    const client = new PgxClient({ embedUrl: EMBED_URL, fetchImpl, batchSize: 2 });
    await expect(client.embed(['a', 'b', 'c', 'd', 'e'])).rejects.toThrow(PgxUnavailableError);

    expect(started).toEqual(['ab', 'cd']);
    expect(maxInFlight).toBe(1);
  });

  it('embed() returns [] without calling fetch for an empty input array', async () => {
    const fetchImpl: FetchLike = vi.fn();
    const client = new PgxClient({ embedUrl: EMBED_URL, fetchImpl });

    await expect(client.embed([])).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rerank() posts to /rerank with the reranker model and returns results ordered by descending score', async () => {
    const fetchImpl: FetchLike = vi.fn(async (url, init) => {
      expect(url).toBe(`${RERANK_URL}/rerank`);
      const body = parseBody(init);
      expect(body.model).toBe('bge-reranker-v2-m3');
      expect(body.query).toBe('search terms');
      expect(body.documents).toEqual(['doc0', 'doc1', 'doc2']);
      return jsonResponse({
        results: [
          { index: 0, relevance_score: 0.2 },
          { index: 1, relevance_score: 0.9 },
          { index: 2, relevance_score: 0.5 },
        ],
      });
    });

    const client = new PgxClient({ rerankUrl: RERANK_URL, fetchImpl });
    const results = await client.rerank('search terms', ['doc0', 'doc1', 'doc2']);

    expect(results).toEqual([
      { index: 1, score: 0.9 },
      { index: 2, score: 0.5 },
      { index: 0, score: 0.2 },
    ]);
  });

  it('fails CLOSED with PgxUnavailableError on a non-2xx response', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse({ error: 'boom' }, 503));
    const client = new PgxClient({ embedUrl: EMBED_URL, fetchImpl });

    await expect(client.embed(['x'])).rejects.toThrow(PgxUnavailableError);
  });

  it('fails CLOSED with PgxUnavailableError when fetch rejects (network error)', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new PgxClient({ embedUrl: EMBED_URL, fetchImpl });

    await expect(client.embed(['x'])).rejects.toThrow(PgxUnavailableError);
  });

  it('fails CLOSED with PgxUnavailableError on timeout', async () => {
    const fetchImpl: FetchLike = vi.fn((_url, init) => rejectOnAbort(init.signal));
    const client = new PgxClient({ embedUrl: EMBED_URL, fetchImpl, timeoutMs: 5 });

    await expect(client.embed(['x'])).rejects.toThrow(PgxUnavailableError);
  });
});

/** Never resolves on its own; rejects once `signal` aborts — stands in for a hung request. */
function rejectOnAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
}
