/**
 * S5869: `HTML_TAG_PATTERN` (used by the survey embed page's
 * `applyHtmlHandler`) had two character classes (`[a-zA-Z]` and
 * `[a-zA-Z0-9]`) that duplicated the `A-Z` range under the pattern's own `i`
 * (case-insensitive) flag — `a-z` already matches uppercase letters
 * case-insensitively, so `A-Z` added nothing. This test proves the deduped
 * pattern (`[a-z]` / `[a-z0-9]`, still with the `i` flag) matches exactly
 * what the original pattern did on every tag shape `applyHtmlHandler`
 * actually allowlists, plus mixed-case and non-tag inputs.
 */
import { describe, expect, it } from 'vitest';
import { HTML_TAG_PATTERN } from '../../src/lib/embed-html';

// The pre-fix pattern, kept here only for comparison.
const OLD_HTML_TAG_PATTERN = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/gi;

function allMatches(pattern: RegExp, input: string): Array<[string, string]> {
  pattern.lastIndex = 0;
  const results: Array<[string, string]> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    results.push([match[0], match[1]]);
  }
  return results;
}

describe('HTML_TAG_PATTERN (S5869 regression)', () => {
  const inputs = [
    // Allowlisted lowercase tags.
    '<p>hello <b>world</b></p>',
    // Uppercase and mixed-case tag names — exercises the case-insensitivity
    // that made the A-Z range in the original pattern redundant.
    '<P>hello <B>world</B></P>',
    '<Span>mixed <EM>case</EM></Span>',
    // Anchor tag with attributes (rewritten by applyHtmlHandler).
    '<a href="https://example.com">link</a>',
    // Self-closing / void-style tag with attributes.
    '<br/>',
    '<BR class="x" />',
    // Non-allowlisted tag, still a valid tag shape the regex must match.
    '<script>alert(1)</script>',
    // No tags at all.
    'just plain text, no tags here',
    // Tag name starting with a digit is not a valid tag per this pattern.
    '<3 not a tag',
  ];

  it.each(inputs)('matches identically to the original pattern for %j', (input) => {
    expect(allMatches(HTML_TAG_PATTERN, input)).toEqual(allMatches(OLD_HTML_TAG_PATTERN, input));
  });
});
