import { describe, it, expect } from 'vitest';
import { parseNextLink } from '../entities';

/**
 * The OLD `parseNextLink` implementation (pre-#2074 S8786 fix), kept here
 * only so this suite can assert the rewritten, backtracking-safe version
 * (see entities.ts) produces byte-identical results on every real Link
 * header shape this codebase actually constructs (see `nextLink()` in
 * connector.test.ts) plus a few malformed edge cases.
 */
function oldParseNextLink(headers: Headers | undefined): string | null {
  const raw = headers?.get?.('link') ?? null;
  if (raw === null || raw.length === 0) return null;

  for (const part of raw.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/** Real + representative Link header values exercised across this codebase's tests. */
const REAL_INPUTS: Array<Record<string, string> | undefined> = [
  undefined,
  {},
  { link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"' },
  { link: '<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=1>; rel="first"' },
  // No spaces around the semicolon.
  { link: '<https://api.github.com/x?page=2>;rel="next"' },
  // Unquoted rel value.
  { link: '<https://api.github.com/x?page=2>; rel=next' },
  // Multiple params on one link.
  { link: '<https://api.github.com/x?page=2&last=1>; rel="next", <https://api.github.com/x&last=1>; rel="last"' },
  // Malformed: no closing '>'.
  { link: '<https://api.github.com/x?page=2; rel="next"' },
  // Empty string.
  { link: '' },
  // Only a "last" rel present.
  { link: '<https://api.github.com/x?page=9>; rel="last"' },
];

describe('parseNextLink (#2074 S8786 regression)', () => {
  it.each(REAL_INPUTS)('matches the pre-fix implementation for %j', (headerInit) => {
    const headers = headerInit === undefined ? undefined : new Headers(headerInit);
    expect(parseNextLink(headers)).toBe(oldParseNextLink(headers));
  });
});
