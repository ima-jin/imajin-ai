/**
 * PGX embed/rerank client (#1601).
 *
 * The PGX is a separate LAN host running two stateless compute endpoints:
 * an OpenAI-compatible embedder (`bge-m3`, 1024-dim) and a reranker
 * (`bge-reranker-v2-m3`). This client is the corpus service's only way of
 * talking to either — it holds no state itself.
 *
 * Fail-CLOSED by design: every network/timeout/non-2xx failure is normalized
 * into a `PgxUnavailableError` (see `../engine/errors.ts`). Callers (the
 * ingest pipeline, hybrid search) are expected to catch it and degrade —
 * never let it propagate into an unhandled rejection or a 500.
 */
import { PgxNotConfiguredError, PgxUnavailableError } from '../engine/errors';
import { mapSequentially } from './sequential';

export const BGE_M3_DIMENSIONS = 1024;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_TIMEOUT_MS = 5000;
const EMBED_MODEL = 'bge-m3';
const RERANK_MODEL = 'bge-reranker-v2-m3';

export interface RerankResult {
  index: number;
  score: number;
}

/** Minimal fetch shape so tests can inject a mock instead of hitting the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PgxClientOptions {
  /** Base URL for the embedder, e.g. "http://pgx.lan:8001". Defaults to `process.env.PGX_EMBED_URL`. */
  embedUrl?: string;
  /** Base URL for the reranker, e.g. "http://pgx.lan:8002". Defaults to `process.env.PGX_RERANK_URL`. */
  rerankUrl?: string;
  /** Max texts per embed request. Defaults to `process.env.PGX_EMBED_BATCH_SIZE` or 64. */
  batchSize?: number;
  /** Per-request timeout in ms. Defaults to `process.env.PGX_TIMEOUT_MS` or 5000. */
  timeoutMs?: number;
  /** Injectable for tests — never hit the real network from a unit test. */
  fetchImpl?: FetchLike;
}

function readIntEnv(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface EmbeddingsResponse {
  data: { embedding: number[]; index: number }[];
}

interface RerankResponse {
  results: { index: number; relevance_score: number }[];
}

/**
 * Thin, fail-closed HTTP client for the PGX embed/rerank endpoints. A single
 * instance is safe to share across requests — it holds no per-call state.
 */
export class PgxClient {
  private readonly embedUrl?: string;
  private readonly rerankUrl?: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: PgxClientOptions = {}) {
    this.embedUrl = options.embedUrl ?? process.env.PGX_EMBED_URL ?? undefined;
    this.rerankUrl = options.rerankUrl ?? process.env.PGX_RERANK_URL ?? undefined;
    this.batchSize = options.batchSize ?? readIntEnv(process.env.PGX_EMBED_BATCH_SIZE, DEFAULT_BATCH_SIZE);
    this.timeoutMs = options.timeoutMs ?? readIntEnv(process.env.PGX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /** True once `PGX_EMBED_URL` (or the constructor override) is set. */
  isConfigured(): boolean {
    return Boolean(this.embedUrl);
  }

  /** True once `PGX_RERANK_URL` (or the constructor override) is set. */
  hasRerank(): boolean {
    return Boolean(this.rerankUrl);
  }

  /**
   * Embeds `texts` in `batchSize`-sized batches, preserving input order.
   * Throws `PgxNotConfiguredError` if `PGX_EMBED_URL` is unset, or
   * `PgxUnavailableError` if any batch request fails.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.embedUrl) {
      throw new PgxNotConfiguredError('embed');
    }
    if (texts.length === 0) {
      return [];
    }

    const embedUrl = this.embedUrl;
    const batches: string[][] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      batches.push(texts.slice(start, start + this.batchSize));
    }
    // Sequential on purpose: one batch in flight at a time keeps load on the single PGX host bounded.
    const batchEmbeddings = await mapSequentially(batches, batch => this.embedBatch(embedUrl, batch));
    return batchEmbeddings.flat();
  }

  /**
   * Reranks `docs` against `query`, returning `{ index, score }` pairs
   * ordered by descending relevance. `index` refers to `docs`' original
   * positions. Throws `PgxNotConfiguredError`/`PgxUnavailableError` per the
   * same rules as `embed`.
   */
  async rerank(query: string, docs: string[]): Promise<RerankResult[]> {
    if (!this.rerankUrl) {
      throw new PgxNotConfiguredError('rerank');
    }
    if (docs.length === 0) {
      return [];
    }

    const body = JSON.stringify({ model: RERANK_MODEL, query, documents: docs });
    const payload = await this.post<RerankResponse>('rerank', this.rerankUrl, '/rerank', body);
    return payload.results
      .map(result => ({ index: result.index, score: result.relevance_score }))
      .sort((left, right) => right.score - left.score);
  }

  private async embedBatch(embedUrl: string, batch: string[]): Promise<number[][]> {
    const body = JSON.stringify({ model: EMBED_MODEL, input: batch });
    const payload = await this.post<EmbeddingsResponse>('embed', embedUrl, '/v1/embeddings', body);
    return [...payload.data].sort((left, right) => left.index - right.index).map(item => item.embedding);
  }

  private async post<TResponse>(endpoint: 'embed' | 'rerank', baseUrl: string, path: string, body: string): Promise<TResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return (await response.json()) as TResponse;
    } catch (error) {
      throw new PgxUnavailableError(endpoint, baseUrl, error);
    } finally {
      clearTimeout(timeout);
    }
  }
}
