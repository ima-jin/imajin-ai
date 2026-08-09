import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalAdapter, parseLocalSource } from '../adapters/local';
import { CorpusEngine } from '../engine';
import type { ThreadDocument } from '../engine/types';

async function collect(iterable: AsyncIterable<ThreadDocument>): Promise<ThreadDocument[]> {
  const docs: ThreadDocument[] = [];
  for await (const doc of iterable) docs.push(doc);
  return docs;
}

function writeFile(dir: string, relPath: string, content: string): string {
  const absolutePath = join(dir, relPath);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
  return absolutePath;
}

describe('parseLocalSource', () => {
  it('parses the directory path from a local: source string', () => {
    expect(parseLocalSource('local:/workspace/docs')).toBe('/workspace/docs');
  });

  it('throws on a source string without a local: prefix', () => {
    expect(() => parseLocalSource('github:ima-jin/imajin-ai')).toThrow(/Invalid local source/);
  });
});

describe('LocalAdapter#fetch', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'corpus-local-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces a valid ThreadDocument from a markdown file', async () => {
    writeFile(dir, 'guide.md', '# Setup guide\n\nRun the installer. See #42 and https://example.com/docs.');

    const adapter = new LocalAdapter();
    const docs = await collect(adapter.fetch(`local:${dir}`));

    expect(docs).toHaveLength(1);
    const [doc] = docs;
    expect(doc.source).toBe(`local:${dir}`);
    expect(doc.sourceType).toBe('local');
    expect(doc.id).toBe('guide.md');
    expect(doc.type).toBe('doc');
    expect(doc.title).toBe('Setup guide');
    expect(doc.state).toBe('open');
    expect(doc.labels).toEqual([]);
    expect(doc.author).toBe('');
    expect(doc.comments).toEqual([]);
    expect(doc.linkedRefs).toEqual(expect.arrayContaining(['#42', 'https://example.com/docs.']));
    expect(doc.url).toBe(`file://${join(dir, 'guide.md')}`);
    expect(typeof doc.created).toBe('string');
    expect(typeof doc.updated).toBe('string');
    expect(doc.meta).toMatchObject({ mtime: expect.any(String) });
  });

  it('extracts the title from the first H1 heading', async () => {
    writeFile(dir, 'notes.md', 'Some intro text.\n\n# The Real Title\n\nMore text.');

    const adapter = new LocalAdapter();
    const [doc] = await collect(adapter.fetch(`local:${dir}`));

    expect(doc.title).toBe('The Real Title');
  });

  it('falls back to the filename when there is no H1 heading', async () => {
    writeFile(dir, 'plain.txt', 'Just plain text, no heading.');

    const adapter = new LocalAdapter();
    const [doc] = await collect(adapter.fetch(`local:${dir}`));

    expect(doc.title).toBe('plain.txt');
  });

  it('prefers a frontmatter title over an H1 heading', async () => {
    writeFile(dir, 'fm.md', '---\ntitle: Frontmatter Title\nlabels: [a, b]\nauthor: alice\n---\n# Ignored Heading\nBody text.');

    const adapter = new LocalAdapter();
    const [doc] = await collect(adapter.fetch(`local:${dir}`));

    expect(doc.title).toBe('Frontmatter Title');
    expect(doc.labels).toEqual(['a', 'b']);
    expect(doc.author).toBe('alice');
    expect(doc.body).not.toContain('title: Frontmatter Title');
  });

  it('classifies code files with type "code"', async () => {
    writeFile(dir, 'index.ts', 'export const x = 1;');
    writeFile(dir, 'script.js', 'console.log(1);');

    const adapter = new LocalAdapter();
    const docs = await collect(adapter.fetch(`local:${dir}`));

    expect(docs).toHaveLength(2);
    for (const doc of docs) {
      expect(doc.type).toBe('code');
    }
  });

  it('ignores files with unrecognized extensions', async () => {
    writeFile(dir, 'image.png', 'not-really-an-image');
    writeFile(dir, 'notes.md', '# Kept\nkept content');

    const adapter = new LocalAdapter();
    const docs = await collect(adapter.fetch(`local:${dir}`));

    expect(docs.map(d => d.id)).toEqual(['notes.md']);
  });

  it('produces correct relative ids for a nested directory structure', async () => {
    writeFile(dir, 'guides/setup.md', '# Setup');
    writeFile(dir, 'guides/nested/deep.md', '# Deep');
    writeFile(dir, 'root.md', '# Root');

    const adapter = new LocalAdapter();
    const docs = await collect(adapter.fetch(`local:${dir}`));

    expect(docs.map(d => d.id).sort()).toEqual(['guides/nested/deep.md', 'guides/setup.md', 'root.md']);
  });

  it('respects the limit option', async () => {
    writeFile(dir, 'a.md', '# A');
    writeFile(dir, 'b.md', '# B');
    writeFile(dir, 'c.md', '# C');

    const adapter = new LocalAdapter();
    const docs = await collect(adapter.fetch(`local:${dir}`, { limit: 2 }));

    expect(docs).toHaveLength(2);
  });

  it('stops iterating once the signal is aborted', async () => {
    writeFile(dir, 'a.md', '# A');
    writeFile(dir, 'b.md', '# B');

    const controller = new AbortController();
    controller.abort();

    const adapter = new LocalAdapter();
    await expect(collect(adapter.fetch(`local:${dir}`, { signal: controller.signal }))).rejects.toThrow(/aborted/);
  });
});

describe('LocalAdapter#sync', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'corpus-local-sync-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns only files modified after the cursor', async () => {
    const oldPath = writeFile(dir, 'old.md', '# Old');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(oldPath, old, old);

    const cursor = '2024-01-01T00:00:00.000Z';

    const newPath = writeFile(dir, 'new.md', '# New');
    const recent = new Date('2024-06-01T00:00:00Z');
    utimesSync(newPath, recent, recent);

    const adapter = new LocalAdapter();
    const result = await adapter.sync(`local:${dir}`, cursor);

    expect(result.documents.map(d => d.id)).toEqual(['new.md']);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBe(recent.toISOString());
  });

  it('returns every file and a fresh cursor on the first sync (null cursor)', async () => {
    const path1 = writeFile(dir, 'a.md', '# A');
    const path2 = writeFile(dir, 'b.md', '# B');
    utimesSync(path1, new Date('2023-01-01T00:00:00Z'), new Date('2023-01-01T00:00:00Z'));
    utimesSync(path2, new Date('2023-06-01T00:00:00Z'), new Date('2023-06-01T00:00:00Z'));

    const adapter = new LocalAdapter();
    const result = await adapter.sync(`local:${dir}`, null);

    expect(result.documents.map(d => d.id).sort()).toEqual(['a.md', 'b.md']);
    expect(result.cursor).toBe(new Date('2023-06-01T00:00:00Z').toISOString());
  });
});

// ─── Integration: proves the engine requires zero changes ────────────────────

describe('LocalAdapter + CorpusEngine integration', () => {
  let dir: string;
  let dataDir: string;
  let engine: CorpusEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'corpus-local-integration-'));
    dataDir = mkdtempSync(join(tmpdir(), 'corpus-engine-integration-'));
    engine = new CorpusEngine({ dataDir });
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('indexes LocalAdapter documents and returns them from search, with zero engine changes', async () => {
    writeFile(
      dir,
      'discord-oauth.md',
      '# Discord connector OAuth bug\n\nOAuth token refresh fails after reconnect.',
    );
    writeFile(dir, 'billing.md', '# Billing docs\n\nInvoices and receipts.');

    const source = `local:${dir}`;
    const adapter = new LocalAdapter();
    const documents = await collect(adapter.fetch(source));

    engine.ingest('did:example:alice', documents);
    const result = engine.search('did:example:alice', { query: 'OAuth reconnect' });

    expect(result.totalHits).toBe(1);
    expect(result.results[0]).toMatchObject({
      source,
      id: 'discord-oauth.md',
      title: 'Discord connector OAuth bug',
    });
    expect(result.results[0].evidence[0]).toContain('OAuth');
  });
});
