/**
 * Acceptance test for #1921 (sha-pinned snapshot queries): ingest a
 * `local:workspace` source at git sha A, query `ref=A`, run `/sync` to a
 * second commit sha B, then query `ref=A` again. The two `ref=A` responses
 * must be identical (including chunk content hashes), while `ref=B` must
 * reflect the new content. Run against a real temp git repo with two
 * commits, over the actual HTTP routes, mirroring the issue's own verify
 * script.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CorpusEngine } from '../engine';
import { createCorpusApp } from '../routes';
import { workspaceRootForDid } from '../lib/workspace';

const did = 'did:example:refcheck';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd }).toString('utf8').trim();
}

describe('sha-pinned snapshot queries — reproducible retrieval at a ref (#1921)', () => {
  let dataDir: string;
  let workspacesDir: string;
  let engine: CorpusEngine;
  let app: ReturnType<typeof createCorpusApp>;
  let workspaceRoot: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'corpus-ref-integration-data-'));
    workspacesDir = mkdtempSync(join(tmpdir(), 'corpus-ref-integration-workspaces-'));
    engine = new CorpusEngine({ dataDir });
    app = createCorpusApp(engine, { workspacesDir });

    workspaceRoot = workspaceRootForDid(did, { workspacesDir });
    mkdirSync(workspaceRoot, { recursive: true });
    git(workspaceRoot, ['init', '-q']);
    git(workspaceRoot, ['config', 'user.email', 'a@b.c']);
    git(workspaceRoot, ['config', 'user.name', 'a']);
  });

  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspacesDir, { recursive: true, force: true });
  });

  it('returns identical results and chunk hashes for ref=A across an intervening sync, and different results for ref=B', async () => {
    writeFileSync(join(workspaceRoot, 'a.md'), '# A\n\nhello', 'utf8');
    git(workspaceRoot, ['add', '.']);
    git(workspaceRoot, ['commit', '-q', '-m', 'A']);
    const shaA = git(workspaceRoot, ['rev-parse', 'HEAD']);

    const crawl = await request(app).post(`/corpus/${did}/crawl`).send({ source: 'local:workspace' });
    expect(crawl.status).toBe(200);
    expect(crawl.body).toEqual({ ingested: 1 });

    const searchAtAFirst = await request(app)
      .post(`/corpus/${did}/search`)
      .send({ query: 'hello', source: 'local:workspace', ref: shaA });
    expect(searchAtAFirst.status).toBe(200);
    expect(searchAtAFirst.body.totalHits).toBe(1);

    writeFileSync(join(workspaceRoot, 'a.md'), '# A\n\nhello world', 'utf8');
    git(workspaceRoot, ['commit', '-qam', 'B']);
    const shaB = git(workspaceRoot, ['rev-parse', 'HEAD']);
    expect(shaB).not.toBe(shaA);

    const sync = await request(app).post(`/corpus/${did}/sync`).send({ source: 'local:workspace', cursor: null });
    expect(sync.status).toBe(200);

    const searchAtASecond = await request(app)
      .post(`/corpus/${did}/search`)
      .send({ query: 'hello', source: 'local:workspace', ref: shaA });
    expect(searchAtASecond.status).toBe(200);

    // Identical result set AND identical chunk hashes, despite the sync in
    // between (excluding `freshness`, which legitimately advances with the sync).
    expect(searchAtASecond.body.results).toEqual(searchAtAFirst.body.results);
    expect(searchAtASecond.body.totalHits).toBe(searchAtAFirst.body.totalHits);
    expect(searchAtASecond.body.results[0].contentHash).toBe(searchAtAFirst.body.results[0].contentHash);
    expect(searchAtASecond.body.provenance).toEqual(searchAtAFirst.body.provenance);

    // "world" only exists in the tree at sha B.
    const worldAtA = await request(app)
      .post(`/corpus/${did}/search`)
      .send({ query: 'world', source: 'local:workspace', ref: shaA });
    expect(worldAtA.body.totalHits).toBe(0);

    const worldAtB = await request(app)
      .post(`/corpus/${did}/search`)
      .send({ query: 'world', source: 'local:workspace', ref: shaB });
    expect(worldAtB.status).toBe(200);
    expect(worldAtB.body.totalHits).toBe(1);
    expect(worldAtB.body.results[0].contentHash).not.toBe(searchAtAFirst.body.results[0].contentHash);

    // Unknown ref never falls back to HEAD — it 404s with a clear hint.
    const unknownRef = '0'.repeat(40);
    const unknown = await request(app)
      .post(`/corpus/${did}/search`)
      .send({ query: 'hello', source: 'local:workspace', ref: unknownRef });
    expect(unknown.status).toBe(404);
    expect(unknown.body.hint).toBe('trigger ingest at this ref');
  });
});
