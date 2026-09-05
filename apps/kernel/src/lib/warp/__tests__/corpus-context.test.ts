/**
 * Tests for the corpus-context block builder (#2021's "one real consumer"
 * checklist item).
 *
 * `dispatch.test.ts` covers the end-to-end wiring (prompt prepending, audit
 * metadata, DID isolation, failure -> no-run). This file pins the block's own
 * shape in isolation: provenance line, hit ordering, and truncation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { searchCorpusMock, MockCorpusServiceError } = vi.hoisted(() => {
  class MockCorpusServiceError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'CorpusServiceError';
      this.status = status;
    }
  }

  return { searchCorpusMock: vi.fn(), MockCorpusServiceError };
});

vi.mock('../../kernel/corpus-client', () => ({
  searchCorpus: searchCorpusMock,
  CorpusServiceError: MockCorpusServiceError,
}));

import {
  buildCorpusContextBlock,
  fetchCorpusContext,
  CorpusContextError,
  CORPUS_CONTEXT_DEFAULT_LIMIT,
  CORPUS_CONTEXT_DEFAULT_MAX_CHARS,
  CORPUS_CONTEXT_MAX_LIMIT,
} from '../corpus-context';
import type { CorpusSearchHit } from '../../kernel/corpus-client';

const PRINCIPAL = 'did:imajin:veteze';

function hit(overrides: Partial<CorpusSearchHit> = {}): CorpusSearchHit {
  return {
    source: 'github:ima-jin/imajin-ai',
    id: '1',
    type: 'issue',
    title: 'Fix the login error',
    state: 'open',
    score: 0.5,
    evidence: ['a quote'],
    updated: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  searchCorpusMock.mockReset();
});

// ── buildCorpusContextBlock ───────────────────────────────────────────────────

describe('buildCorpusContextBlock', () => {
  it('opens with the heading and a provenance line naming source, ref, hits, and retrievedAt', () => {
    const { block } = buildCorpusContextBlock(
      [hit()],
      { source: 'github:ima-jin/imajin-ai', ref: 'deadbeef', retrievedAt: '2026-09-01T00:00:00.000Z' },
      6000,
    );

    const lines = block.split('\n\n');
    expect(lines[0]).toBe('## Retrieved context (corpus)');
    expect(lines[1]).toBe(
      'source=github:ima-jin/imajin-ai ref=deadbeef hits=1 retrievedAt=2026-09-01T00:00:00.000Z',
    );
  });

  it('reports ref=unpinned when no ref was given', () => {
    const { block } = buildCorpusContextBlock(
      [],
      { source: 's', ref: undefined, retrievedAt: '2026-09-01T00:00:00.000Z' },
      6000,
    );

    expect(block).toContain('ref=unpinned');
  });

  it('renders each hit as a heading with score, and the snippet below it, in order', () => {
    const first = hit({ title: 'First issue', score: 0.9, evidence: ['first evidence'] });
    const second = hit({ title: 'Second issue', score: 0.4, evidence: ['second evidence'] });

    const { block } = buildCorpusContextBlock(
      [first, second],
      { source: 's', ref: undefined, retrievedAt: '2026-09-01T00:00:00.000Z' },
      6000,
    );

    const firstIndex = block.indexOf('### First issue (score=0.90)');
    const secondIndex = block.indexOf('### Second issue (score=0.40)');
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(block).toContain('first evidence');
    expect(block).toContain('second evidence');
  });

  it('includes contentHash in the heading only when the hit carries one', () => {
    const withHash = buildCorpusContextBlock(
      [hit({ contentHash: 'sha256:abc' })],
      { source: 's', ref: 'deadbeef', retrievedAt: '2026-09-01T00:00:00.000Z' },
      6000,
    );
    expect(withHash.block).toContain('(score=0.50, contentHash=sha256:abc)');
    expect(withHash.contentHashes).toEqual(['sha256:abc']);

    const withoutHash = buildCorpusContextBlock(
      [hit()],
      { source: 's', ref: undefined, retrievedAt: '2026-09-01T00:00:00.000Z' },
      6000,
    );
    expect(withoutHash.block).toContain('(score=0.50)');
    expect(withoutHash.contentHashes).toEqual([]);
  });

  it('deduplicates content hashes across hits', () => {
    const { contentHashes } = buildCorpusContextBlock(
      [hit({ id: '1', contentHash: 'sha256:same' }), hit({ id: '2', contentHash: 'sha256:same' })],
      { source: 's', ref: 'deadbeef', retrievedAt: '2026-09-01T00:00:00.000Z' },
      6000,
    );
    expect(contentHashes).toEqual(['sha256:same']);
  });

  it('truncates the whole block to maxChars, with a trailing ellipsis', () => {
    const longHit = hit({ evidence: ['x'.repeat(500)] });
    const { block } = buildCorpusContextBlock(
      [longHit],
      { source: 's', ref: undefined, retrievedAt: '2026-09-01T00:00:00.000Z' },
      50,
    );

    expect(block.length).toBe(51); // 50 chars + the ellipsis character
    expect(block.endsWith('…')).toBe(true);
  });

  it('does not truncate when the block already fits within maxChars', () => {
    const { block } = buildCorpusContextBlock(
      [hit()],
      { source: 's', ref: undefined, retrievedAt: '2026-09-01T00:00:00.000Z' },
      6000,
    );
    expect(block.endsWith('…')).toBe(false);
  });

  it('produces just the heading and provenance line when there are no hits', () => {
    const { block, contentHashes } = buildCorpusContextBlock(
      [],
      { source: 's', ref: undefined, retrievedAt: '2026-09-01T00:00:00.000Z' },
      6000,
    );
    expect(block).toBe('## Retrieved context (corpus)\n\nsource=s ref=unpinned hits=0 retrievedAt=2026-09-01T00:00:00.000Z');
    expect(contentHashes).toEqual([]);
  });
});

// ── fetchCorpusContext ────────────────────────────────────────────────────────

describe('fetchCorpusContext', () => {
  it('searches the given DID with the default limit and no ref when neither is given', async () => {
    searchCorpusMock.mockResolvedValue({ results: [], totalHits: 0, tokensUsed: 0 });

    await fetchCorpusContext(PRINCIPAL, { source: 's', query: 'q' });

    expect(searchCorpusMock).toHaveBeenCalledWith(PRINCIPAL, {
      query: 'q',
      source: 's',
      limit: CORPUS_CONTEXT_DEFAULT_LIMIT,
    });
  });

  it('clamps an out-of-range limit into [1, 20]', async () => {
    searchCorpusMock.mockResolvedValue({ results: [], totalHits: 0, tokensUsed: 0 });

    await fetchCorpusContext(PRINCIPAL, { source: 's', query: 'q', limit: 500 });
    expect(searchCorpusMock).toHaveBeenLastCalledWith(
      PRINCIPAL,
      expect.objectContaining({ limit: CORPUS_CONTEXT_MAX_LIMIT }),
    );

    await fetchCorpusContext(PRINCIPAL, { source: 's', query: 'q', limit: -5 });
    expect(searchCorpusMock).toHaveBeenLastCalledWith(PRINCIPAL, expect.objectContaining({ limit: 1 }));
  });

  it('falls back to the default maxChars for a non-positive or missing value', async () => {
    searchCorpusMock.mockResolvedValue({
      results: [hit({ evidence: ['y'.repeat(CORPUS_CONTEXT_DEFAULT_MAX_CHARS + 500)] })],
      totalHits: 1,
      tokensUsed: 0,
    });

    const result = await fetchCorpusContext(PRINCIPAL, { source: 's', query: 'q', maxChars: -1 });
    expect(result.promptPrefix.length).toBe(CORPUS_CONTEXT_DEFAULT_MAX_CHARS + 1);
  });

  it('reports the metadata a later reader needs, without the snippet text', async () => {
    searchCorpusMock.mockResolvedValue({
      results: [hit({ contentHash: 'sha256:abc', evidence: ['do not persist this snippet'] })],
      totalHits: 1,
      tokensUsed: 0,
    });

    const result = await fetchCorpusContext(PRINCIPAL, { source: 's', query: 'q', ref: 'deadbeef' });

    expect(result.metadata).toMatchObject({
      source: 's',
      ref: 'deadbeef',
      hits: 1,
      contentHashes: ['sha256:abc'],
    });
    expect(typeof result.metadata.retrievedAt).toBe('string');
    expect(JSON.stringify(result.metadata)).not.toContain('do not persist this snippet');
  });

  it('omits ref from metadata when none was given', async () => {
    searchCorpusMock.mockResolvedValue({ results: [], totalHits: 0, tokensUsed: 0 });

    const result = await fetchCorpusContext(PRINCIPAL, { source: 's', query: 'q' });
    expect(result.metadata).not.toHaveProperty('ref');
  });

  it('wraps a corpus 401 (bad access claim) as a 400-class CorpusContextError', async () => {
    const { CorpusServiceError } = await import('../../kernel/corpus-client');
    searchCorpusMock.mockRejectedValue(new CorpusServiceError(401, 'bad claim'));

    const err = (await fetchCorpusContext(PRINCIPAL, { source: 's', query: 'q' }).catch(
      (e: unknown) => e,
    )) as CorpusContextError;

    expect(err).toBeInstanceOf(CorpusContextError);
    expect(err.status).toBe(400);
    expect(err.corpusStatus).toBe(401);
  });

  it('wraps a corpus 404 (unknown ref) as a 400-class CorpusContextError', async () => {
    const { CorpusServiceError } = await import('../../kernel/corpus-client');
    searchCorpusMock.mockRejectedValue(new CorpusServiceError(404, 'no indexed snapshot for that ref'));

    const err = (await fetchCorpusContext(PRINCIPAL, { source: 's', query: 'q', ref: 'bad-sha' }).catch(
      (e: unknown) => e,
    )) as CorpusContextError;

    expect(err).toBeInstanceOf(CorpusContextError);
    expect(err.status).toBe(400);
    expect(err.corpusStatus).toBe(404);
  });

  it('wraps a corpus 500 as a 502-class CorpusContextError', async () => {
    const { CorpusServiceError } = await import('../../kernel/corpus-client');
    searchCorpusMock.mockRejectedValue(new CorpusServiceError(500, 'internal error'));

    const err = (await fetchCorpusContext(PRINCIPAL, { source: 's', query: 'q' }).catch(
      (e: unknown) => e,
    )) as CorpusContextError;

    expect(err).toBeInstanceOf(CorpusContextError);
    expect(err.status).toBe(502);
    expect(err.corpusStatus).toBe(500);
  });

  it('wraps a network-level failure as a 502-class CorpusContextError', async () => {
    searchCorpusMock.mockRejectedValue(new Error('fetch failed'));

    const err = (await fetchCorpusContext(PRINCIPAL, { source: 's', query: 'q' }).catch(
      (e: unknown) => e,
    )) as CorpusContextError;

    expect(err).toBeInstanceOf(CorpusContextError);
    expect(err.status).toBe(502);
    expect(err.corpusStatus).toBe(0);
  });
});
