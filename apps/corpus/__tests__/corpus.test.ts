import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
import { CorpusEngine } from '../src/engine';
import type { ThreadDocument } from '../src/engine/types';
import { createCorpusApp } from '../src/routes';
import { mintTestClaimHeader } from '../src/__tests__/support/mint-test-claim';

describe('CorpusEngine', () => {
  let dataDir: string;
  let engine: CorpusEngine;
  let now: Date;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'corpus-test-'));
    now = new Date('2026-08-09T17:00:00.000Z');
    engine = new CorpusEngine({ dataDir, now: () => now });
  });

  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('ingests threads and returns matching search results', () => {
    engine.ingest('did:example:alice', [
      thread({ id: '1', title: 'Discord connector OAuth bug', body: 'OAuth token refresh fails after reconnect.' }),
      thread({ id: '2', title: 'Billing docs', body: 'Invoices and receipts.' }),
    ]);

    const result = engine.search('did:example:alice', { query: 'OAuth reconnect' });

    expect(result.totalHits).toBe(1);
    expect(result.results[0]).toMatchObject({
      source: 'github:ima-jin/imajin-ai',
      id: '1',
      title: 'Discord connector OAuth bug',
    });
    expect(result.results[0].evidence[0]).toContain('OAuth');
  });

  it('boosts fixed and merged resolutions above otherwise similar unresolved hits', () => {
    engine.ingest('did:example:alice', [
      thread({
        id: 'open',
        title: 'Webhook retry timeout',
        body: 'Webhook retry timeout timeout timeout',
      }),
      thread({
        id: 'fixed',
        title: 'Webhook retry timeout',
        body: 'Webhook retry timeout',
        resolution: { kind: 'fixed', fixedBy: 'abc123' },
      }),
    ]);

    const result = engine.search('did:example:alice', { query: 'webhook timeout', limit: 2 });

    expect(result.results[0].id).toBe('fixed');
    expect(result.results[0].score).toBeGreaterThan(result.results[1].score);
  });

  it('caps evidence by the requested token budget', () => {
    engine.ingest('did:example:alice', [
      thread({ id: 'long', title: 'Long context', body: `needle ${'word '.repeat(500)}` }),
    ]);

    const result = engine.search('did:example:alice', { query: 'needle', budget: 12 });

    expect(result.tokensUsed).toBeLessThanOrEqual(12);
    expect(result.results[0].evidence.join('').length).toBeLessThanOrEqual(48);
  });

  it('keeps databases isolated per owner DID', () => {
    engine.ingest('did:example:alice', [thread({ id: 'shared', title: 'Alice secret', body: 'private alpaca memo' })]);
    engine.ingest('did:example:bob', [thread({ id: 'shared', title: 'Bob secret', body: 'private badger memo' })]);

    const alice = engine.search('did:example:alice', { query: 'badger private' });
    const bob = engine.search('did:example:bob', { query: 'badger private' });

    expect(alice.results).toHaveLength(0);
    expect(bob.results).toHaveLength(1);
    expect(bob.results[0].title).toBe('Bob secret');
  });

  it('upserts duplicate source/id pairs instead of duplicating them', () => {
    engine.ingest('did:example:alice', [thread({ id: '1', title: 'Old title', body: 'legacy keyword' })]);
    engine.ingest('did:example:alice', [thread({ id: '1', title: 'New title', body: 'fresh keyword' })]);

    const status = engine.status('did:example:alice');
    const oldResult = engine.search('did:example:alice', { query: 'legacy' });
    const newResult = engine.search('did:example:alice', { query: 'fresh' });

    expect(status.threadCount).toBe(1);
    expect(oldResult.totalHits).toBe(0);
    expect(newResult.results[0].title).toBe('New title');
  });

  it('adds freshness warnings for stale source indexes', () => {
    now = new Date('2026-01-01T00:00:00.000Z');
    engine.ingest('did:example:alice', [thread({ id: '1', title: 'Fresh once', body: 'searchable' })]);
    now = new Date('2026-01-10T00:00:00.000Z');

    const status = engine.status('did:example:alice');

    expect(status.sources[0]).toMatchObject({
      source: 'github:ima-jin/imajin-ai',
      threadCount: 1,
      warning: 'stale',
    });
  });

  it('deletes all threads for a source', () => {
    engine.ingest('did:example:alice', [
      thread({ id: '1', source: 'github:ima-jin/imajin-ai', title: 'GitHub bug', body: 'octocat' }),
      thread({ id: '2', source: 'slack:team', sourceType: 'slack', title: 'Slack bug', body: 'chatops' }),
    ]);

    const deleted = engine.deleteSource('did:example:alice', 'github:ima-jin/imajin-ai');

    expect(deleted.deleted).toBe(1);
    expect(engine.search('did:example:alice', { query: 'octocat' }).totalHits).toBe(0);
    expect(engine.status('did:example:alice').threadCount).toBe(1);
  });
});

describe('corpus routes', () => {
  let dataDir: string;
  let engine: CorpusEngine;

  const ORIGINAL_KERNEL_PUBLIC_KEY = process.env.CORPUS_KERNEL_PUBLIC_KEY;
  const kernelKeypair = authCrypto.generateKeypair();

  beforeEach(() => {
    process.env.CORPUS_KERNEL_PUBLIC_KEY = kernelKeypair.publicKey;
    dataDir = mkdtempSync(join(tmpdir(), 'corpus-route-test-'));
    engine = new CorpusEngine({ dataDir, now: () => new Date('2026-08-09T17:00:00.000Z') });
  });

  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
    if (ORIGINAL_KERNEL_PUBLIC_KEY === undefined) delete process.env.CORPUS_KERNEL_PUBLIC_KEY;
    else process.env.CORPUS_KERNEL_PUBLIC_KEY = ORIGINAL_KERNEL_PUBLIC_KEY;
  });

  it('supports ingest then search over HTTP', async () => {
    const app = createCorpusApp(engine);
    const did = encodeURIComponent('did:example:alice');

    await request(app)
      .post(`/corpus/${did}/ingest`)
      .set('Authorization', mintTestClaimHeader(kernelKeypair.privateKey, { did: 'did:example:alice', scope: 'corpus:write' }))
      .send([thread({ id: '1', title: 'Corpus service', body: 'BM25 search service' })])
      .expect(200)
      .expect(response => {
        expect(response.body).toEqual({ ingested: 1 });
      });

    await request(app)
      .post(`/corpus/${did}/search`)
      .set('Authorization', mintTestClaimHeader(kernelKeypair.privateKey, { did: 'did:example:alice', scope: 'corpus:read' }))
      .send({ query: 'BM25', limit: 1 })
      .expect(200)
      .expect(response => {
        expect(response.body).toMatchObject({
          totalHits: 1,
          tokensUsed: expect.any(Number),
        });
        expect(response.body.results[0]).toMatchObject({
          source: 'github:ima-jin/imajin-ai',
          id: '1',
          type: 'issue',
          title: 'Corpus service',
          state: 'open',
          score: expect.any(Number),
          evidence: expect.any(Array),
          updated: '2026-08-09T16:00:00.000Z',
        });
        expect(response.body.freshness[0]).toMatchObject({
          source: 'github:ima-jin/imajin-ai',
          threadCount: 1,
        });
      });
  });

  it('exposes health and sync placeholder routes', async () => {
    const app = createCorpusApp(engine);

    await request(app).get('/health').expect(200, { ok: true, service: 'corpus' });
    await request(app)
      .post('/corpus/did%3Aexample%3Aalice/sync')
      .set('Authorization', mintTestClaimHeader(kernelKeypair.privateKey, { did: 'did:example:alice', scope: 'corpus:write' }))
      .send({})
      .expect(501);
  });
});

function thread(overrides: Partial<ThreadDocument>): ThreadDocument {
  return {
    source: overrides.source ?? 'github:ima-jin/imajin-ai',
    sourceType: overrides.sourceType ?? 'github',
    id: overrides.id ?? '1',
    type: overrides.type ?? 'issue',
    title: overrides.title ?? 'Default title',
    state: overrides.state ?? 'open',
    labels: overrides.labels ?? ['bug'],
    author: overrides.author ?? 'octocat',
    authorDid: overrides.authorDid,
    created: overrides.created ?? '2026-08-09T15:00:00.000Z',
    closed: overrides.closed,
    updated: overrides.updated ?? '2026-08-09T16:00:00.000Z',
    linkedRefs: overrides.linkedRefs ?? [],
    body: overrides.body ?? 'Default body',
    comments: overrides.comments ?? [
      {
        author: 'hubot',
        body: 'Default comment',
        created: '2026-08-09T16:30:00.000Z',
        type: 'comment',
      },
    ],
    resolution: overrides.resolution,
    url: overrides.url ?? 'https://github.com/ima-jin/imajin-ai/issues/1',
    meta: overrides.meta,
  };
}
