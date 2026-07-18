import { describe, it, expect } from 'vitest';
import { isSafeNext } from '../safe-next';

const ORIGIN = 'https://mcp.imajin.ai';

describe('isSafeNext', () => {
  it('accepts a relative same-origin path', () => {
    expect(isSafeNext('/profile/edit', ORIGIN)).toBe(true);
    expect(isSafeNext('/', ORIGIN)).toBe(true);
  });

  it('accepts a same-origin ABSOLUTE url (the MCP OAuth authorize round-trip, #1185)', () => {
    const next =
      'https://mcp.imajin.ai/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A6274%2Foauth%2Fcallback';
    expect(isSafeNext(next, ORIGIN)).toBe(true);
  });

  it('rejects a cross-origin absolute url (open-redirect guard)', () => {
    expect(isSafeNext('https://evil.example.com/oauth/authorize', ORIGIN)).toBe(false);
    expect(isSafeNext('http://mcp.imajin.ai/x', ORIGIN)).toBe(false); // scheme differs → different origin
  });

  it('rejects protocol-relative urls', () => {
    expect(isSafeNext('//evil.example.com/x', ORIGIN)).toBe(false);
  });

  it('rejects null / empty / garbage', () => {
    expect(isSafeNext(null, ORIGIN)).toBe(false);
    expect(isSafeNext('', ORIGIN)).toBe(false);
    expect(isSafeNext('not a url', ORIGIN)).toBe(false);
  });
});
