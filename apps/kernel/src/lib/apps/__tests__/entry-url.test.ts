/**
 * Tests for the manifest `entryUrl` validator (#2434).
 */
import { describe, it, expect } from 'vitest';
import { validateEntryUrl, assertValidEntryUrl } from '../entry-url';

describe('validateEntryUrl — accepted', () => {
  it.each([
    ['relative path', '/dykil'],
    ['relative path with query', '/dykil/home?tab=1'],
    ['https URL', 'https://dykil.example.com'],
    ['https URL with path', 'https://dykil.example.com/app?x=1'],
  ])('accepts a %s', (_label, value) => {
    expect(validateEntryUrl(value)).toEqual({ ok: true, value });
    expect(assertValidEntryUrl(value)).toBe(value);
  });
});

describe('validateEntryUrl — rejected', () => {
  it.each([
    ['http URL', 'http://dykil.example.com'],
    ['javascript: URL', 'javascript:alert(1)'],
    ['mixed-case javascript: URL', 'JaVaScRiPt:alert(1)'],
    ['data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['protocol-relative URL', '//evil.example.com/app'],
    ['backslash protocol-relative URL', '/\\evil.example.com'],
    ['bare host', 'dykil.example.com'],
    ['bare relative path', 'dykil'],
    ['empty string', ''],
    ['https URL with credentials', 'https://user:pass@dykil.example.com'],
    ['URL with an embedded newline', 'https://dykil.example.com/\nfoo'],
    ['https scheme smuggled behind a tab', 'java\tscript:alert(1)'],
    ['absurdly long value', `/${'a'.repeat(3000)}`],
  ])('rejects a %s', (_label, value) => {
    const result = validateEntryUrl(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('Invalid manifest entryUrl');
    expect(result.error).toContain('root-relative path');
    expect(() => assertValidEntryUrl(value)).toThrow(/Invalid manifest entryUrl/);
  });

  it('names the offending scheme in the error', () => {
    const result = validateEntryUrl('javascript:alert(1)');
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('javascript:');
  });

  it('truncates a long value in the error message', () => {
    const result = validateEntryUrl(`http://${'a'.repeat(500)}.example.com`);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.length).toBeLessThan(300);
  });
});
