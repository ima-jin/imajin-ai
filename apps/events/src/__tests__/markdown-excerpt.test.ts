/**
 * Tests for the markdown-span guard predicates extracted from
 * stripMarkdownLinksAndImages() into src/lib/markdown-excerpt.ts (#2067 —
 * cognitive complexity reduction). These are cheap pure functions, so we
 * unit test them directly rather than the homepage excerpt rendering.
 */
import { describe, it, expect } from 'vitest';
import { matchMarkdownImage, matchMarkdownLink, stripMarkdown } from '../lib/markdown-excerpt';

describe('matchMarkdownImage', () => {
  it('matches image syntax and reports the index just past the closing paren', () => {
    const input = '![alt text](https://example.com/img.png) rest';
    const match = matchMarkdownImage(input, 0);
    expect(match).toEqual({ text: '', nextIndex: input.indexOf(')') + 1 });
  });

  it('returns null when not positioned at an image marker', () => {
    expect(matchMarkdownImage('[label](url)', 0)).toBeNull();
  });

  it('returns null for an unterminated image syntax', () => {
    expect(matchMarkdownImage('![alt](url', 0)).toBeNull();
    expect(matchMarkdownImage('![alt', 0)).toBeNull();
  });
});

describe('matchMarkdownLink', () => {
  it('matches link syntax and keeps the label text', () => {
    const input = '[label](https://example.com) rest';
    const match = matchMarkdownLink(input, 0);
    expect(match).toEqual({ text: 'label', nextIndex: input.indexOf(')') + 1 });
  });

  it('returns null when not positioned at a link marker', () => {
    expect(matchMarkdownLink('plain text', 0)).toBeNull();
  });

  it('returns null for an unterminated link syntax', () => {
    expect(matchMarkdownLink('[label](url', 0)).toBeNull();
    expect(matchMarkdownLink('[label', 0)).toBeNull();
  });
});

describe('stripMarkdown', () => {
  it('drops images and keeps link labels alongside other markdown stripping', () => {
    const text = '# Title\n![banner](https://example.com/b.png)Check out [our site](https://example.com) for **details**.';
    expect(stripMarkdown(text)).toBe('Title Check out our site for details.');
  });
});
