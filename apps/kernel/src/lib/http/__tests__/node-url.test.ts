import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nodeUrl } from '../node-url';

/**
 * #1614 — the node URL was built as `${NEXT_PUBLIC_SERVICE_PREFIX}${NEXT_PUBLIC_DOMAIN}`,
 * which only holds when the prefix is a bare scheme. In single-domain mode the
 * prefix is a full origin, so the concat produced `https://jin.imajin.ai/imajin.ai`
 * and every advertised endpoint 404'd.
 */

const ENV_KEYS = [
  'APP_URL',
  'NEXT_PUBLIC_BASE_URL',
  'NEXT_PUBLIC_SERVICE_PREFIX',
  'NEXT_PUBLIC_DOMAIN',
] as const;

beforeEach(() => {
  // Baseline: nothing configured, so each test exercises the real "unset"
  // branches. stubEnv records the original value (which unstubAllEnvs restores);
  // the delete is what actually clears it, since an empty string is not unset.
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, '');
    delete process.env[key];
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('nodeUrl — single-domain prefix (what prod runs)', () => {
  it('does not double the host into a path segment', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'https://jin.imajin.ai/');
    vi.stubEnv('NEXT_PUBLIC_DOMAIN', 'imajin.ai');
    expect(nodeUrl()).toBe('https://jin.imajin.ai');
  });

  it('tolerates a prefix with no trailing slash', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'https://dev-jin.imajin.ai');
    vi.stubEnv('NEXT_PUBLIC_DOMAIN', 'imajin.ai');
    expect(nodeUrl()).toBe('https://dev-jin.imajin.ai');
  });
});

describe('nodeUrl — legacy scheme-only prefix', () => {
  it('resolves to the apex of NEXT_PUBLIC_DOMAIN', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'https://');
    vi.stubEnv('NEXT_PUBLIC_DOMAIN', 'mynode.example');
    expect(nodeUrl()).toBe('https://mynode.example');
  });

  it('defaults to https://imajin.ai when nothing is configured', () => {
    expect(nodeUrl()).toBe('https://imajin.ai');
  });

  it('does not build a kernel.* subdomain (the buildPublicUrlAbsolute trap)', () => {
    vi.stubEnv('NEXT_PUBLIC_DOMAIN', 'mynode.example');
    expect(nodeUrl()).not.toContain('kernel.');
  });
});

describe('nodeUrl — explicit public origin takes precedence', () => {
  it('prefers APP_URL over everything else', () => {
    vi.stubEnv('APP_URL', 'https://jin.imajin.ai');
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://stale.imajin.ai');
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'https://');
    vi.stubEnv('NEXT_PUBLIC_DOMAIN', 'wrong.example');
    expect(nodeUrl()).toBe('https://jin.imajin.ai');
  });

  it('falls back to NEXT_PUBLIC_BASE_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'http://localhost:3000');
    expect(nodeUrl()).toBe('http://localhost:3000');
  });

  it('strips a path from a configured origin', () => {
    vi.stubEnv('APP_URL', 'https://jin.imajin.ai/chat');
    expect(nodeUrl()).toBe('https://jin.imajin.ai');
  });

  it('ignores an unparseable configured origin and derives instead', () => {
    vi.stubEnv('APP_URL', 'not-a-url');
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'https://jin.imajin.ai/');
    expect(nodeUrl()).toBe('https://jin.imajin.ai');
  });
});

describe('nodeUrl — invariants', () => {
  it.each([
    ['https://jin.imajin.ai/', 'imajin.ai'],
    ['https://', 'imajin.ai'],
    ['http://localhost:', 'imajin.ai'],
  ])('never ends in a slash (prefix=%s domain=%s)', (prefix, domain) => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', prefix);
    vi.stubEnv('NEXT_PUBLIC_DOMAIN', domain);
    expect(nodeUrl()).not.toMatch(/\/$/);
  });

  it('preserves an http:// scheme from the prefix', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'http://my-node.local/');
    expect(nodeUrl()).toBe('http://my-node.local');
  });
});
