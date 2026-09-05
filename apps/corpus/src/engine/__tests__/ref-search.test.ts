import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CorpusEngine } from '../index';
import { UnknownRefError } from '../errors';
import type { ThreadDocument } from '../types';

const SOURCE = 'local:workspace';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function doc(overrides: Partial<ThreadDocument>): ThreadDocument {
  return {
    source: SOURCE,
    sourceType: 'local',
    id: overrides.id ?? 'a.md',
    type: 'doc',
    title: overrides.title ?? 'A',
    state: 'open',
    labels: [],
    author: 'a',
    created: '2026-08-09T15:00:00.000Z',
    updated: '2026-08-09T16:00:00.000Z',
    linkedRefs: [],
    body: overrides.body ?? 'hello',
    comments: [],
    ...overrides,
  };
}

describe('CorpusEngine ref-pinned search (#1921)', () => {
  let dataDir: string;
  let engine: CorpusEngine;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'corpus-ref-search-'));
    engine = new CorpusEngine({ dataDir, now: () => new Date('2026-09-01T00:00:00.000Z') });
  });

  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('throws UnknownRefError for a ref that was never ingested', () => {
    engine.ingest('did:example:alice', [doc({ body: 'hello' })], SHA_A);

    expect(() => engine.search('did:example:alice', { query: 'hello', source: SOURCE, ref: '0'.repeat(40) })).toThrow(
      UnknownRefError,
    );
  });

  it('requires source when ref is set', () => {
    expect(() => engine.search('did:example:alice', { query: 'hello', ref: SHA_A })).toThrow(/source is required/);
  });

  it('is deterministic across an intervening ingest at a new ref, including content hashes', () => {
    engine.ingest('did:example:alice', [doc({ body: 'hello' })], SHA_A);

    const first = engine.search('did:example:alice', { query: 'hello', source: SOURCE, ref: SHA_A });

    // Simulate a "/sync" to a new sha with changed content.
    engine.ingest('did:example:alice', [doc({ body: 'hello world' })], SHA_B);

    const second = engine.search('did:example:alice', { query: 'hello', source: SOURCE, ref: SHA_A });

    expect(second).toEqual(first);
    expect(first.provenance?.chunks).toEqual(second.provenance?.chunks);
    expect(first.results[0].contentHash).toBeDefined();
  });

  it('resolves different content at a different ref', () => {
    engine.ingest('did:example:alice', [doc({ body: 'hello' })], SHA_A);
    engine.ingest('did:example:alice', [doc({ body: 'hello world' })], SHA_B);

    const atA = engine.search('did:example:alice', { query: 'world', source: SOURCE, ref: SHA_A });
    const atB = engine.search('did:example:alice', { query: 'world', source: SOURCE, ref: SHA_B });

    expect(atA.totalHits).toBe(0);
    expect(atB.totalHits).toBe(1);
    expect(atA.provenance?.ref).toBe(SHA_A);
    expect(atB.provenance?.ref).toBe(SHA_B);
  });

  it('never returns ref-pinned results for a plain, unpinned search', () => {
    engine.ingest('did:example:alice', [doc({ body: 'hello' })], SHA_A);

    const result = engine.search('did:example:alice', { query: 'hello' });

    expect(result.provenance).toBeUndefined();
    expect(result.results[0].contentHash).toBeUndefined();
  });

  it('does not record a ref manifest for ingests without a resolved ref', () => {
    engine.ingest('did:example:alice', [doc({ body: 'hello' })]);

    expect(() => engine.search('did:example:alice', { query: 'hello', source: SOURCE, ref: SHA_A })).toThrow(
      UnknownRefError,
    );
  });
});
