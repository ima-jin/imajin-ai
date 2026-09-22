import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import { serializeFrontmatter, parseFrontmatter, composeArticleFile, splitFrontmatter } from '../frontmatter';
import type { ArticleBlock } from '../article-core';

const base: ArticleBlock = {
  slug: 'hello-world',
  title: 'Hello, World',
  status: 'DRAFT',
  date: '2026-06-29',
};

describe('serializeFrontmatter', () => {
  it('emits a --- delimited YAML header with only the defined fields', () => {
    const out = serializeFrontmatter(base);
    expect(out.startsWith('---\n')).toBe(true);
    expect(out.trimEnd().endsWith('---')).toBe(true);
    expect(out).toContain('slug: "hello-world"');
    expect(out).toContain('title: "Hello, World"');
    expect(out).toContain('status: "DRAFT"');
    expect(out).toContain('date: "2026-06-29"');
    expect(out).not.toContain('subtitle');
    expect(out).not.toContain('description');
    expect(out).not.toContain('order');
  });

  it('includes optional fields when present', () => {
    const out = serializeFrontmatter({ ...base, subtitle: 'Sub', description: 'Desc', order: 3 });
    expect(out).toContain('subtitle: "Sub"');
    expect(out).toContain('description: "Desc"');
    expect(out).toContain('order: 3');
  });

  it('escapes embedded quotes and newlines so the YAML stays valid', () => {
    const out = serializeFrontmatter({ ...base, title: 'A "quoted"\nline' });
    // Round-trips back to the exact original string via gray-matter.
    const { data } = parseFrontmatter(`${out}\nbody`);
    expect(data.title).toBe('A "quoted"\nline');
  });
});

describe('parseFrontmatter', () => {
  it('returns empty data + original body when there is no frontmatter', () => {
    const md = '# Just a note\n\nNo header here.';
    const { data, body } = parseFrontmatter(md);
    expect(data).toEqual({});
    expect(body.trim()).toBe(md.trim());
  });

  it('treats malformed YAML as "no frontmatter" instead of throwing', () => {
    expect(() => parseFrontmatter('---\n: : : bad\n---\nbody')).not.toThrow();
  });

  it('is safe when handed a non-string (e.g. a failed file read)', () => {
    expect(parseFrontmatter(undefined as unknown as string)).toEqual({ data: {}, body: '' });
  });
});

describe('round-trip (compose -> parse)', () => {
  it('recovers every article field and the body', () => {
    const article: ArticleBlock = { ...base, subtitle: 'S', description: 'D', order: 2, status: 'POSTED' };
    const body = '# Heading\n\nSome **markdown** body.';
    const { data, body: parsedBody } = parseFrontmatter(composeArticleFile(article, body));
    expect(data.slug).toBe(article.slug);
    expect(data.title).toBe(article.title);
    expect(data.subtitle).toBe('S');
    expect(data.description).toBe('D');
    expect(data.status).toBe('POSTED');
    expect(data.order).toBe(2);
    expect(parsedBody.trim()).toBe(body.trim());
  });

  it('keeps the date as a STRING (gray-matter must not coerce it to a Date)', () => {
    const reread = matter(composeArticleFile(base, 'body'));
    expect(typeof reread.data.date).toBe('string');
    expect(reread.data.date).toBe('2026-06-29');
  });

  it('composes a header-only file when the body is empty', () => {
    const file = composeArticleFile(base, '');
    expect(file.trimEnd().endsWith('---')).toBe(true);
    expect(parseFrontmatter(file).body.trim()).toBe('');
  });

  it('does not accumulate leading blank lines across repeated writes', () => {
    const first = composeArticleFile(base, 'body');
    const second = composeArticleFile(base, parseFrontmatter(first).body);
    expect(second).toBe(first);
  });
});

// #1445 — the metadata editor round-trips parse -> edit -> serialize -> save
// strictly through this codec. These fixtures assert that repeating the
// parse/serialize cycle on the codec's own output is stable (idempotent).
describe('parse -> serialize -> parse stability (#1445)', () => {
  const fixtures: Array<[string, ArticleBlock]> = [
    ['minimal fields only', base],
    ['all optional fields present', { ...base, subtitle: 'Sub', description: 'Desc', order: 2, status: 'POSTED' }],
    ['a different slug/status combination', { ...base, slug: 'other-slug', status: 'REVIEW' }],
  ];

  it.each(fixtures)('is stable for %s', (_label, article) => {
    const file = composeArticleFile(article, '# Body\n\nSome text.');
    const firstParse = parseFrontmatter(file);
    const reserialized = composeArticleFile(firstParse.data as unknown as ArticleBlock, firstParse.body);
    const secondParse = parseFrontmatter(reserialized);

    expect(reserialized).toBe(file);
    expect(secondParse.data).toEqual(firstParse.data);
    expect(secondParse.body).toBe(firstParse.body);
  });
});

describe('splitFrontmatter', () => {
  it('splits header and body without altering a single byte (header + body === original)', () => {
    const file = composeArticleFile(base, '# Heading\n\nBody text.');
    const { header, body, data } = splitFrontmatter(file);
    expect(header + body).toBe(file);
    expect(data.slug).toBe(base.slug);
    expect(body.trim()).toBe('# Heading\n\nBody text.');
  });

  it('preserves unknown keys and key order verbatim in the header (never re-serializes)', () => {
    const raw = '---\ncustomKey: "kept"\nslug: "x"\ntitle: "T"\nstatus: "DRAFT"\ndate: "2026-01-01"\n---\n\nBody\n';
    const { header, body } = splitFrontmatter(raw);
    expect(header).toBe('---\ncustomKey: "kept"\nslug: "x"\ntitle: "T"\nstatus: "DRAFT"\ndate: "2026-01-01"\n---\n');
    expect(header + body).toBe(raw);
  });

  it('returns an empty header and the original text as body when there is no frontmatter', () => {
    const md = '# Just a note\n\ntext';
    const { header, body, data } = splitFrontmatter(md);
    expect(header).toBe('');
    expect(body).toBe(md);
    expect(data).toEqual({});
  });

  it('is safe for non-string input', () => {
    expect(splitFrontmatter(undefined as unknown as string)).toEqual({ header: '', body: '', data: {} });
  });
});
