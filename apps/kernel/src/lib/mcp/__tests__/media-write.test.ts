import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { McpContent, McpToolContext } from '../types';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockSet = vi.fn();
const mockWhere = vi.fn();

// Backs deriveArticleProjection (article-core) — the projection upsert.
vi.mock('@/src/db', () => ({
  db: { update: vi.fn(() => ({ set: mockSet })) },
  assets: {},
}));

vi.mock('@/src/lib/media/create-asset', () => ({
  createAsset: vi.fn(),
  inferMime: vi.fn(() => 'text/markdown'),
  isAllowedMime: vi.fn(() => true),
}));

// media_update isn't exercised here; stub the heavy versioning substrate.
vi.mock('@/src/lib/media/update-asset', () => ({
  updateAssetContent: vi.fn(),
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));
// Bypass the scope-manifest channel_links gate — unit tests for the gate
// itself live in mcp-grant.test.ts; here we just want the tool logic.
vi.mock('../mcp-grant', () => ({ requireMcpGrant: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

import { mediaWriteTools } from '../tools/media-write';
import { createAsset } from '@/src/lib/media/create-asset';
import { updateAssetContent } from '@/src/lib/media/update-asset';
import { publish } from '@imajin/bus';
import { db } from '@/src/db';

// ─── Helpers ───────────────────────────────────────────────────────────────

const ctx: McpToolContext = {
  did: 'did:imajin:user',
  appDid: 'did:imajin:app',
  scopes: new Set(['media:write']),
};

function tool(name: string) {
  const t = mediaWriteTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

function parseResult(content: McpContent[]) {
  return JSON.parse(content[0].text);
}

function mockCreatedAsset(overrides: Record<string, unknown> = {}) {
  vi.mocked(createAsset).mockResolvedValueOnce({
    asset: {
      id: 'asset_new',
      filename: 'x.md',
      mimeType: 'text/markdown',
      ownerDid: ctx.did,
      cid: 'cid_1',
      size: 10,
      metadata: {},
      createdAt: new Date('2026-06-29T00:00:00Z'),
      ...overrides,
    },
    deduplicated: false,
  } as never);
}

function writtenContent(): string {
  return (vi.mocked(createAsset).mock.calls[0][0].buffer as Buffer).toString('utf8');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSet.mockReturnValue({ where: mockWhere });
  mockWhere.mockResolvedValue(undefined);
});

// ─── media_create_note ──────────────────────────────────────────────────────

describe('media_create_note', () => {
  it('requires only content (no article fields)', () => {
    expect(tool('media_create_note').inputSchema.required).toEqual(['content']);
  });

  it('stores plain markdown with no frontmatter and no article projection', async () => {
    mockCreatedAsset({ filename: 'note-1.md' });
    const res = await tool('media_create_note').handler({ content: 'just a note' }, ctx);

    const arg = vi.mocked(createAsset).mock.calls[0][0];
    expect(arg.mimeType).toBe('text/markdown');
    expect(arg.access).toBe('private');
    expect(arg.dedup).toBe(false);
    expect(writtenContent()).toBe('just a note');
    expect(writtenContent()).not.toContain('---');

    // A note never becomes an article projection and never publishes.
    expect(db.update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();

    const out = parseResult(res as McpContent[]);
    expect(out.id).toBe('asset_new');
    expect(out.article).toBeUndefined();
  });
});

// ─── media_upload ───────────────────────────────────────────────────────────

describe('media_upload', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('description no longer claims a fixed "10 MB" limit', () => {
    expect(tool('media_upload').description).not.toMatch(/10 ?MB/i);
  });

  it('description explains the app-upload → reference-by-id path', () => {
    const description = tool('media_upload').description;
    expect(description).toMatch(/Imajin app/);
    expect(description).toMatch(/asset id/);
  });

  it('returns a structured payload_too_large error instead of throwing when oversize', async () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://node.example';
    const oversizeB64 = Buffer.alloc(11 * 1024 * 1024, 1).toString('base64');

    const res = await tool('media_upload').handler(
      { filename: 'huge.bin', data_base64: oversizeB64 },
      ctx,
    );
    const out = parseResult(res as McpContent[]);

    expect(out.error.code).toBe('payload_too_large');
    expect(out.error.limitBytes).toBe(10 * 1024 * 1024);
    expect(out.error.uploadUrl).toBe('https://node.example/media');
    expect(createAsset).not.toHaveBeenCalled();
  });

  it('falls back to MEDIA_PUBLIC_URL, then empty string, for uploadUrl', async () => {
    delete process.env.NEXT_PUBLIC_BASE_URL;
    process.env.MEDIA_PUBLIC_URL = 'https://media.example';
    const oversizeB64 = Buffer.alloc(11 * 1024 * 1024, 1).toString('base64');

    const res = await tool('media_upload').handler(
      { filename: 'huge.bin', data_base64: oversizeB64 },
      ctx,
    );
    const out = parseResult(res as McpContent[]);
    expect(out.error.uploadUrl).toBe('https://media.example/media');
  });

  it('uploads normally when under the byte limit', async () => {
    mockCreatedAsset({ filename: 'small.txt', mimeType: 'text/plain', size: 5 });
    const smallB64 = Buffer.from('hello').toString('base64');

    const res = await tool('media_upload').handler(
      { filename: 'small.txt', data_base64: smallB64 },
      ctx,
    );
    const out = parseResult(res as McpContent[]);

    expect(createAsset).toHaveBeenCalledTimes(1);
    expect(out.id).toBe('asset_new');
    expect(out.error).toBeUndefined();
  });

  it('includes url and hash in the verbose response', async () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://node.example';
    mockCreatedAsset({ filename: 'small.txt', mimeType: 'text/plain', size: 5, hash: 'abc123' });
    const smallB64 = Buffer.from('hello').toString('base64');

    const res = await tool('media_upload').handler({ filename: 'small.txt', data_base64: smallB64 }, ctx);
    const out = parseResult(res as McpContent[]);

    expect(out.hash).toBe('abc123');
    expect(out.url).toBe('https://node.example/media/api/assets/asset_new');
  });

  it('quiet: true returns only the compact { id, url, hash, size, mimeType } shape (#2282 item 5)', async () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://node.example';
    mockCreatedAsset({ filename: 'small.txt', mimeType: 'text/plain', size: 5, hash: 'abc123' });
    const smallB64 = Buffer.from('hello').toString('base64');

    const res = await tool('media_upload').handler(
      { filename: 'small.txt', data_base64: smallB64, quiet: true },
      ctx,
    );
    const out = parseResult(res as McpContent[]);

    expect(Object.keys(out).sort()).toEqual(['hash', 'id', 'mimeType', 'size', 'url']);
    expect(out.id).toBe('asset_new');
    expect(out.hash).toBe('abc123');
    expect(out.url).toBe('https://node.example/media/api/assets/asset_new');
  });
});

// ─── media_create_article ───────────────────────────────────────────────────

describe('media_create_article', () => {
  it('writes YAML frontmatter into the file and defaults status to DRAFT', async () => {
    mockCreatedAsset();
    const res = await tool('media_create_article').handler(
      { title: 'Hello', slug: 'hello', content: '# Body' },
      ctx,
    );

    const written = writtenContent();
    expect(written.startsWith('---\n')).toBe(true);
    expect(written).toContain('slug: "hello"');
    expect(written).toContain('title: "Hello"');
    expect(written).toContain('status: "DRAFT"');
    expect(written).toContain('# Body');

    // Projection re-derived from the file we wrote; bus event emitted.
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      'asset.article.published',
      expect.objectContaining({ payload: expect.objectContaining({ status: 'DRAFT', slug: 'hello' }) }),
    );

    const out = parseResult(res as McpContent[]);
    expect(out.article.status).toBe('DRAFT');
    expect(out.article.slug).toBe('hello');
  });

  it('preserves an explicitly supplied POSTED status', async () => {
    mockCreatedAsset();
    await tool('media_create_article').handler(
      { title: 'T', slug: 'posted-one', content: 'b', status: 'POSTED' },
      ctx,
    );
    expect(writtenContent()).toContain('status: "POSTED"');
    expect(publish).toHaveBeenCalledWith(
      'asset.article.published',
      expect.objectContaining({ payload: expect.objectContaining({ status: 'POSTED' }) }),
    );
  });

  it('rejects an invalid slug before creating an asset', async () => {
    await expect(
      tool('media_create_article').handler({ title: 'T', slug: 'Bad Slug', content: 'b' }, ctx),
    ).rejects.toThrow(/slug/);
    expect(createAsset).not.toHaveBeenCalled();
  });
});

// ─── media_update — article frontmatter guard (#1542) ───────────────────────

describe('media_update', () => {
  const updatedAsset = {
    id: 'asset_x',
    filename: 'x.md',
    mimeType: 'text/markdown',
    size: 10,
    versionCount: 2,
    cid: 'cid_2',
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  };

  it('surfaces the demotion warning and the articleProjection: null flag', async () => {
    vi.mocked(updateAssetContent).mockResolvedValueOnce({
      ok: true,
      asset: updatedAsset,
      articleWarning: {
        warning: 'DEMOTION: … will STOP rendering as an article',
        reason: 'missing_frontmatter',
        demotes: true,
      },
    } as never);

    const res = await tool('media_update').handler({ id: 'asset_x', content: '# no header' }, ctx);
    const out = parseResult(res as McpContent[]);

    expect(out.articleProjection).toBeNull();
    expect(out.articleWarningReason).toBe('missing_frontmatter');
    expect(out.warning).toContain('DEMOTION');
  });

  it('omits the warning fields on a clean write', async () => {
    vi.mocked(updateAssetContent).mockResolvedValueOnce({ ok: true, asset: updatedAsset } as never);

    const res = await tool('media_update').handler({ id: 'asset_x', content: 'body' }, ctx);
    const out = parseResult(res as McpContent[]);

    expect(out.warning).toBeUndefined();
    expect('articleProjection' in out).toBe(false);
  });

  it('forwards strict to the shared write path and throws on rejection', async () => {
    vi.mocked(updateAssetContent).mockResolvedValueOnce({
      ok: false,
      code: 'article_frontmatter_required',
      message: 'article-context markdown has no frontmatter title',
    } as never);

    await expect(
      tool('media_update').handler({ id: 'asset_x', content: '# no header', strict: true }, ctx),
    ).rejects.toThrow(/no frontmatter title/);

    expect(vi.mocked(updateAssetContent).mock.calls[0][0].strict).toBe(true);
  });
});
