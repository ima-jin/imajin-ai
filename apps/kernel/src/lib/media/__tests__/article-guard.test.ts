import { describe, it, expect, vi } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// article-guard is pure, but it imports article-core (for the projection
// decision), which pulls in the DB module at load time. Nothing here touches
// the DB — deriveArticleProjection is never called.

vi.mock('@/src/db', () => ({
  db: { update: vi.fn() },
  assets: {},
}));

import {
  articleWarningFields,
  checkArticleFrontmatter,
  hasArticleProjection,
  isArticleContext,
} from '../article-guard';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const HEADERLESS = '# Newsletter\n\nBody with no YAML header at all.\n';
const VALID_ARTICLE =
  '---\nslug: "hello"\ntitle: "Hello"\nstatus: "DRAFT"\ndate: "2026-08-01"\n---\n\n# Hello\n';
const TITLELESS_HEADER = '---\nslug: "hello"\nstatus: "DRAFT"\n---\n\n# Hello\n';

const ARTICLE_CONTEXT = { app: 'article' };
const LIVE_ARTICLE_METADATA = {
  article: { slug: 'hello', title: 'Hello', status: 'POSTED', date: '2026-08-01' },
};

// ─── isArticleContext / hasArticleProjection ───────────────────────────────

describe('isArticleContext', () => {
  it('matches article intent on app or feature, case-insensitively', () => {
    expect(isArticleContext({ app: 'article' })).toBe(true);
    expect(isArticleContext({ feature: 'Articles' })).toBe(true);
    expect(isArticleContext({ app: 'www', feature: 'article' })).toBe(true);
  });

  it('is false for non-article contexts and non-objects', () => {
    expect(isArticleContext({ app: 'chat' })).toBe(false);
    expect(isArticleContext({})).toBe(false);
    expect(isArticleContext(null)).toBe(false);
    expect(isArticleContext('article')).toBe(false);
  });
});

describe('hasArticleProjection', () => {
  it('detects an existing metadata.article block', () => {
    expect(hasArticleProjection(LIVE_ARTICLE_METADATA)).toBe(true);
    expect(hasArticleProjection({ context: { app: 'article' } })).toBe(false);
    expect(hasArticleProjection(null)).toBe(false);
  });
});

// ─── checkArticleFrontmatter ───────────────────────────────────────────────

describe('checkArticleFrontmatter — plain notes are unaffected', () => {
  it('does not warn for headerless markdown with no article intent (Lane 2 capture)', () => {
    expect(
      checkArticleFrontmatter({ mimeType: 'text/markdown', content: HEADERLESS }),
    ).toBeNull();
  });

  it('does not warn for a non-article upload context', () => {
    expect(
      checkArticleFrontmatter({
        mimeType: 'text/markdown',
        content: HEADERLESS,
        context: { app: 'chat' },
      }),
    ).toBeNull();
  });

  it('does not warn for non-markdown content even under article context', () => {
    expect(
      checkArticleFrontmatter({
        mimeType: 'text/plain',
        content: HEADERLESS,
        context: ARTICLE_CONTEXT,
      }),
    ).toBeNull();
  });
});

describe('checkArticleFrontmatter — article context', () => {
  it('warns with the machine-readable reason when there is no frontmatter', () => {
    const check = checkArticleFrontmatter({
      mimeType: 'text/markdown',
      content: HEADERLESS,
      context: ARTICLE_CONTEXT,
    });

    expect(check).not.toBeNull();
    expect(check?.reason).toBe('missing_frontmatter');
    expect(check?.demotes).toBe(false);
    expect(check?.warning).toBe(
      'article-context markdown has no frontmatter title — metadata.article will be null; asset will NOT render as an article',
    );
  });

  it('warns when a header exists but carries no title', () => {
    const check = checkArticleFrontmatter({
      mimeType: 'text/markdown',
      content: TITLELESS_HEADER,
      context: ARTICLE_CONTEXT,
    });

    expect(check?.reason).toBe('invalid_frontmatter');
    expect(check?.warning).toContain('title is required');
    expect(check?.warning).toContain('will NOT render as an article');
  });

  it('stays silent when the frontmatter is a valid article', () => {
    expect(
      checkArticleFrontmatter({
        mimeType: 'text/markdown',
        content: VALID_ARTICLE,
        context: ARTICLE_CONTEXT,
      }),
    ).toBeNull();
  });

  it('picks up article intent from stored metadata.context on the update path', () => {
    const check = checkArticleFrontmatter({
      mimeType: 'text/markdown',
      content: HEADERLESS,
      existingMetadata: { context: { app: 'article' } },
    });

    expect(check?.reason).toBe('missing_frontmatter');
    expect(check?.demotes).toBe(false);
  });
});

describe('checkArticleFrontmatter — demotion of a live article', () => {
  it('flags demotes and says so loudly when the asset already has metadata.article', () => {
    const check = checkArticleFrontmatter({
      mimeType: 'text/markdown',
      content: HEADERLESS,
      existingMetadata: LIVE_ARTICLE_METADATA,
    });

    expect(check?.demotes).toBe(true);
    expect(check?.reason).toBe('missing_frontmatter');
    expect(check?.warning).toContain('DEMOTION');
    expect(check?.warning).toContain('currently a live article');
    expect(check?.warning).toContain('STOP rendering as an article');
  });

  it('does not flag a demotion when the new content keeps valid frontmatter', () => {
    expect(
      checkArticleFrontmatter({
        mimeType: 'text/markdown',
        content: VALID_ARTICLE,
        existingMetadata: LIVE_ARTICLE_METADATA,
      }),
    ).toBeNull();
  });
});

// ─── articleWarningFields ──────────────────────────────────────────────────

describe('articleWarningFields', () => {
  it('spreads to nothing when the check passed', () => {
    expect(articleWarningFields(null)).toEqual({});
  });

  it('carries the warning plus the articleProjection: null flag', () => {
    const check = checkArticleFrontmatter({
      mimeType: 'text/markdown',
      content: HEADERLESS,
      context: ARTICLE_CONTEXT,
    });

    expect(articleWarningFields(check)).toEqual({
      warning: check?.warning,
      articleProjection: null,
      articleWarningReason: 'missing_frontmatter',
    });
  });
});
