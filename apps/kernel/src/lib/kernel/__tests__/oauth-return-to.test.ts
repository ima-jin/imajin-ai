import { describe, it, expect } from 'vitest';
import { sanitizeReturnTo } from '../oauth-return-to';

// ─── oauth-return-to.ts — open-redirect guard (#1529) ────────────────────────
//
// This helper is the only thing standing between a user-supplied `?returnTo=`
// and a `NextResponse.redirect`, so the negative cases matter more than the
// positive ones.

describe('sanitizeReturnTo — accepts same-origin app paths', () => {
  it.each([
    '/',
    '/auth/connectors/quickbooks',
    '/auth/connectors/github?connected=github',
    '/auth/settings#section',
    '/a/b/c?x=1&y=2#frag',
  ])('accepts %s', (path) => {
    expect(sanitizeReturnTo(path)).toBe(path);
  });
});

describe('sanitizeReturnTo — rejects off-origin and malformed values', () => {
  it.each([
    ['absolute https URL', 'https://evil.com/steal'],
    ['absolute http URL', 'http://evil.com'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
    ['protocol-relative', '//evil.com/steal'],
    ['backslash protocol-relative', '/\\evil.com/steal'],
    ['bare host', 'evil.com'],
    ['relative traversal', '../../etc/passwd'],
    ['empty string', ''],
  ])('rejects %s', (_label, raw) => {
    expect(sanitizeReturnTo(raw)).toBeNull();
  });

  it('rejects null and undefined', () => {
    expect(sanitizeReturnTo(null)).toBeNull();
    expect(sanitizeReturnTo(undefined)).toBeNull();
  });

  it('rejects embedded CR/LF (header-splitting vector)', () => {
    expect(sanitizeReturnTo('/ok\r\nLocation: https://evil.com')).toBeNull();
    expect(sanitizeReturnTo('/ok\nx')).toBeNull();
  });

  it('rejects a NUL byte used to truncate downstream parsers', () => {
    expect(sanitizeReturnTo('/ok\u0000https://evil.com')).toBeNull();
  });
});
