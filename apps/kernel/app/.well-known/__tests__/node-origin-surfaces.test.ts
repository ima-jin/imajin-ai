import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #1614 — `fair-policy.json` and `security.txt` built their node URL with the
 * same `${NEXT_PUBLIC_SERVICE_PREFIX}${NEXT_PUBLIC_DOMAIN}` concat as the agent
 * card, so in single-domain mode they advertised `https://jin.imajin.ai/imajin.ai`.
 *
 * These pin the prod-shaped env so the concat cannot come back.
 */

// security.txt returns `new NextResponse(text)` while fair-policy.json uses the
// static `.json()`, so the mock has to support both call shapes.
vi.mock('next/server', () => {
  class MockNextResponse {
    readonly body: unknown;
    readonly headers: Record<string, string>;

    constructor(body: unknown, init?: { headers?: Record<string, string> }) {
      this.body = body;
      this.headers = init?.headers ?? {};
    }

    static json(body: unknown, init?: { headers?: Record<string, string> }) {
      return new MockNextResponse(body, init);
    }
  }
  return { NextResponse: MockNextResponse };
});

const { GET: fairPolicyGET } = await import('../fair-policy.json/route');
const { GET: securityTxtGET } = await import('../security.txt/route');

const SINGLE_DOMAIN_ENV = {
  NEXT_PUBLIC_SERVICE_PREFIX: 'https://jin.imajin.ai/',
  NEXT_PUBLIC_DOMAIN: 'imajin.ai',
} as const;

beforeEach(() => {
  for (const key of ['APP_URL', 'NEXT_PUBLIC_BASE_URL', 'NEXT_PUBLIC_SERVICE_PREFIX', 'NEXT_PUBLIC_DOMAIN']) {
    vi.stubEnv(key, '');
    delete process.env[key];
  }
});

function stub(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

describe('GET /.well-known/fair-policy.json', () => {
  it('advertises the node origin without a doubled host segment', () => {
    stub(SINGLE_DOMAIN_ENV);
    const { body } = fairPolicyGET() as { body: { node: string } };
    expect(body.node).toBe('https://jin.imajin.ai');
  });

  it('resolves to the apex under the legacy scheme-only prefix', () => {
    stub({ NEXT_PUBLIC_SERVICE_PREFIX: 'https://', NEXT_PUBLIC_DOMAIN: 'mynode.example' });
    const { body } = fairPolicyGET() as { body: { node: string } };
    expect(body.node).toBe('https://mynode.example');
  });
});

describe('GET /.well-known/security.txt', () => {
  function canonicalOf(response: unknown): string {
    const text = (response as { body?: string }).body ?? '';
    return text
      .split('\n')
      .find((line) => line.startsWith('Canonical:'))
      ?.replace('Canonical:', '')
      .trim() ?? '';
  }

  it('Canonical points at the real served URL (RFC 9116 §2.5.2)', () => {
    stub(SINGLE_DOMAIN_ENV);
    const response = securityTxtGET();
    expect(canonicalOf(response)).toBe('https://jin.imajin.ai/.well-known/security.txt');
  });

  it('Canonical carries no doubled host segment', () => {
    stub(SINGLE_DOMAIN_ENV);
    expect(canonicalOf(securityTxtGET())).not.toContain('/imajin.ai/');
  });
});
