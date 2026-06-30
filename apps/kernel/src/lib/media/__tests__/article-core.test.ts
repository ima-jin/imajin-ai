import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockSet = vi.fn();
const mockWhere = vi.fn();

vi.mock('@/src/db', () => ({
  db: { update: vi.fn(() => ({ set: mockSet })) },
  assets: {},
}));

import { buildArticleBlock, deriveArticleProjection, type ArticleBlock } from '../article-core';
import { composeArticleFile } from '../frontmatter';
import { db } from '@/src/db';

beforeEach(() => {
  vi.clearAllMocks();
  mockSet.mockReturnValue({ where: mockWhere });
  mockWhere.mockResolvedValue(undefined);
});

// ─── buildArticleBlock ──────────────────────────────────────────────────────

describe('buildArticleBlock', () => {
  it('defaults status to DRAFT when it is unspecified (#1193)', () => {
    const res = buildArticleBlock({ slug: 'a', title: 'A' });
    expect('block' in res ? res.block.status : null).toBe('DRAFT');
  });

  it('preserves an explicitly supplied POSTED status', () => {
    const res = buildArticleBlock({ slug: 'a', title: 'A', status: 'POSTED' });
    expect('block' in res ? res.block.status : null).toBe('POSTED');
  });

  it('falls back to DRAFT for an invalid status value', () => {
    const res = buildArticleBlock({ slug: 'a', title: 'A', status: 'NONSENSE' });
    expect('block' in res ? res.block.status : null).toBe('DRAFT');
  });

  it('errors on a missing or non-URL-safe slug', () => {
    expect('error' in buildArticleBlock({ title: 'A' })).toBe(true);
    expect('error' in buildArticleBlock({ slug: 'Bad Slug', title: 'A' })).toBe(true);
  });

  it('errors on a missing title', () => {
    expect('error' in buildArticleBlock({ slug: 'a' })).toBe(true);
  });
});

// ─── deriveArticleProjection ────────────────────────────────────────────────

const postedArticle: ArticleBlock = {
  slug: 'hello',
  title: 'Hello',
  status: 'POSTED',
  date: '2026-06-29',
};

describe('deriveArticleProjection', () => {
  it('upserts metadata.article from valid frontmatter, preserving other keys', async () => {
    const file = composeArticleFile(postedArticle, 'body');
    const res = await deriveArticleProjection('asset_1', file, { context: { app: 'www' } });

    expect(res.article?.slug).toBe('hello');
    expect(res.article?.status).toBe('POSTED');
    expect(db.update).toHaveBeenCalledTimes(1);
    const setArg = mockSet.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(setArg.metadata).toEqual({ context: { app: 'www' }, article: res.article });
  });

  it('is a no-op for a plain note (no frontmatter)', async () => {
    const res = await deriveArticleProjection('asset_2', '# just a note\n\ntext', {});
    expect(res.article).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('is a no-op when frontmatter lacks slug/title (not an article)', async () => {
    const res = await deriveArticleProjection('asset_3', '---\nfoo: "bar"\n---\nbody', {});
    expect(res.article).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('preserves an explicit POSTED status declared in the file (truth wins)', async () => {
    const file = composeArticleFile({ ...postedArticle, status: 'POSTED' }, 'b');
    const res = await deriveArticleProjection('asset_4', file, {});
    expect(res.article?.status).toBe('POSTED');
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});
