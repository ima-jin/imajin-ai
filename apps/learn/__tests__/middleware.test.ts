import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, config } from '../middleware';

const ENV_KEYS = ['NEXT_PUBLIC_SERVICE_PREFIX', 'NEXT_PUBLIC_DOMAIN'] as const;

describe('learn middleware — standalone dashboard redirect (#2332)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.NEXT_PUBLIC_SERVICE_PREFIX = 'jin.imajin.ai/';
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('308-redirects the standalone /dashboard route to its hub tab, preserving the query string', () => {
    const res = middleware(new NextRequest('https://jin.imajin.ai/dashboard?foo=bar'));

    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://jin.imajin.ai/auth/learn?foo=bar');
  });

  it("excludes the embed route <ServiceEmbed> loads (`?embed=hub`) from the redirect matcher", () => {
    const dashboardMatcher = (config.matcher as Array<string | { source: string; missing?: unknown }>).find(
      (m): m is { source: string; missing?: unknown } => typeof m === 'object' && m.source === '/dashboard',
    );

    expect(dashboardMatcher?.missing).toEqual([{ type: 'query', key: 'embed' }]);
  });
});
