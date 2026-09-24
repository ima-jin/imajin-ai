/**
 * GET /api/health (#2345): every entry in this route's SERVICES list must
 * resolve to a URL `fetch()` can actually parse. Before this fix,
 * `buildPublicUrl()` fell back to a bare relative path (e.g. "/input") once
 * neither an explicit `NEXT_PUBLIC_{NAME}_URL` env var nor an explicit
 * prefix/domain was supplied, and `fetch()` throws a `TypeError: Failed to
 * parse URL from /input` before any request is made — which permanently
 * marked prod "degraded" for a config bug rather than a real outage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SINGLE_DOMAIN_ENV = {
  NEXT_PUBLIC_SERVICE_PREFIX: 'https://jin.imajin.ai/',
  NEXT_PUBLIC_DOMAIN: 'imajin.ai',
} as const;

beforeEach(() => {
  // Prod runs in single-domain mode (base URL + path) without a
  // NEXT_PUBLIC_INPUT_URL override — that's exactly the state that exposed
  // #2345, since the "input" service was retired (see
  // docs/migrations/retire-input-service.md) and its env var removed along
  // with it, while the SERVICES entry itself was left behind.
  for (const [key, value] of Object.entries(SINGLE_DOMAIN_ENV)) vi.stubEnv(key, value);
  delete process.env.NEXT_PUBLIC_INPUT_URL;

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/health', () => {
  it('resolves a parseable, absolute URL for every configured service', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    const body = await res.json() as { services: { name: string; url: string }[] };

    expect(body.services.length).toBeGreaterThan(0);
    for (const service of body.services) {
      expect(() => new URL(service.url)).not.toThrow();
    }
  });

  it('resolves the input service to an absolute URL instead of a bare path (regression for #2345)', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    const body = await res.json() as { services: { name: string; url: string; status: string; error?: string }[] };

    const input = body.services.find((service) => service.name === 'input');
    expect(input?.url).toBe('https://jin.imajin.ai/input');
    expect(input?.error).toBeUndefined();
    expect(input?.status).not.toBe('down');
  });

  it('never leaves the whole kernel reporting degraded solely because of an unparseable service URL', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    const body = await res.json() as { status: string; services: { name: string; error?: string }[] };

    const parseFailures = body.services.filter((service) => service.error?.includes('Failed to parse URL'));
    expect(parseFailures).toEqual([]);
    expect(body.status).toBe('operational');
  });
});
