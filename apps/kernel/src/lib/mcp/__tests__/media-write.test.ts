import { describe, it, expect, vi, beforeEach } from 'vitest';
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
