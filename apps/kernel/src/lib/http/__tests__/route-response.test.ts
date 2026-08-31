import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  wantsHtml,
  buildErrorHtml,
  respondUnauthorized,
  respondForbidden,
  respondPaymentRequired,
} from '../route-response';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(headers: Record<string, string> = {}, url = 'https://test.imajin.ai/media/api/assets/test'): NextRequest {
  return new Request(url, { headers }) as unknown as NextRequest;
}

// ---------------------------------------------------------------------------
// wantsHtml
// ---------------------------------------------------------------------------

describe('wantsHtml', () => {
  it('returns true when Accept includes text/html', () => {
    expect(wantsHtml(makeRequest({ accept: 'text/html' }))).toBe(true);
  });

  it('returns true for browser-style Accept with text/html + wildcards', () => {
    expect(wantsHtml(makeRequest({ accept: 'text/html,application/xhtml+xml,*/*' }))).toBe(true);
  });

  it('returns false for JSON Accept', () => {
    expect(wantsHtml(makeRequest({ accept: 'application/json' }))).toBe(false);
  });

  it('returns false when Accept header is absent', () => {
    expect(wantsHtml(makeRequest())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildErrorHtml
// ---------------------------------------------------------------------------

describe('buildErrorHtml', () => {
  it('escapes HTML entities in title and message', () => {
    const html = buildErrorHtml('<title>&', '<msg>');
    expect(html).toContain('&lt;title&gt;&amp;');
    expect(html).toContain('&lt;msg&gt;');
  });

  it('returns a valid HTML document', () => {
    const html = buildErrorHtml('Access Denied', 'No permission');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Access Denied');
    expect(html).toContain('No permission');
  });
});

// ---------------------------------------------------------------------------
// respondUnauthorized
// ---------------------------------------------------------------------------

describe('respondUnauthorized', () => {
  it('returns 401 JSON with WWW-Authenticate for API clients', async () => {
    const res = respondUnauthorized(makeRequest({ accept: 'application/json' }), '/foo');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
    const body = await res.json();
    expect(body.error).toContain('Authentication required');
  });

  // #1899 — the onboarding discovery pointer on every JSON 401.
  it('includes an onboarding pointer to the agent card for API clients', async () => {
    const res = respondUnauthorized(makeRequest({ accept: 'application/json' }), '/foo');
    const body = await res.json();
    expect(body.onboarding).toBe('https://imajin.ai/.well-known/agent.json');
  });

  it('returns a redirect to login for HTML clients', () => {
    const res = respondUnauthorized(makeRequest({ accept: 'text/html' }), '/protected');
    // Next.js defaults to 307 Temporary Redirect for NextResponse.redirect()
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/auth/login');
    expect(location).toContain(encodeURIComponent('/protected'));
  });

  it('uses the supplied returnTo path in the redirect', () => {
    const res = respondUnauthorized(makeRequest({ accept: 'text/html' }), '/my/path');
    expect(res.headers.get('location')).toContain(encodeURIComponent('/my/path'));
  });
});

// ---------------------------------------------------------------------------
// respondUnauthorized — redirect origin (#1608)
// ---------------------------------------------------------------------------

/**
 * Behind Caddy, request.url is Next's internal fallback origin
 * (http://localhost:3000) regardless of the public host the browser used, so
 * the login redirect must be anchored to the configured public origin instead.
 */
describe('respondUnauthorized redirect origin', () => {
  const INTERNAL_URL = 'http://localhost:3000/media/api/assets/asset_abc';
  const originalAppUrl = process.env.APP_URL;
  const originalBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;

  beforeEach(() => {
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_BASE_URL;
  });

  afterEach(() => {
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
    if (originalBaseUrl === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = originalBaseUrl;
  });

  it('anchors to APP_URL, never the internal request origin', () => {
    process.env.APP_URL = 'https://jin.imajin.ai';
    const res = respondUnauthorized(
      makeRequest({ accept: 'text/html' }, INTERNAL_URL),
      '/media/api/assets/asset_abc',
    );
    const location = res.headers.get('location') ?? '';
    expect(new URL(location).origin).toBe('https://jin.imajin.ai');
    expect(location).not.toContain('localhost');
    expect(new URL(location).pathname).toBe('/auth/login');
  });

  it('anchors to NEXT_PUBLIC_BASE_URL when APP_URL is unset', () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://dev-jin.imajin.ai';
    const res = respondUnauthorized(makeRequest({ accept: 'text/html' }, INTERNAL_URL), '/x');
    expect(new URL(res.headers.get('location') ?? '').origin).toBe('https://dev-jin.imajin.ai');
  });

  it('falls back to the request origin in local dev', () => {
    const res = respondUnauthorized(makeRequest({ accept: 'text/html' }, INTERNAL_URL), '/x');
    expect(new URL(res.headers.get('location') ?? '').origin).toBe('http://localhost:3000');
  });

  it('preserves the next param when re-anchoring', () => {
    process.env.APP_URL = 'https://jin.imajin.ai';
    const res = respondUnauthorized(
      makeRequest({ accept: 'text/html' }, INTERNAL_URL),
      '/media/api/assets/asset_abc',
    );
    const next = new URL(res.headers.get('location') ?? '').searchParams.get('next');
    expect(next).toBe('/media/api/assets/asset_abc');
  });
});

// ---------------------------------------------------------------------------
// respondForbidden
// ---------------------------------------------------------------------------

describe('respondForbidden', () => {
  it('returns 403 JSON with error for API clients', async () => {
    const res = respondForbidden(makeRequest({ accept: 'application/json' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  // #1899 — the onboarding discovery pointer on every JSON 403.
  it('includes an onboarding pointer to the agent card for API clients', async () => {
    const res = respondForbidden(makeRequest({ accept: 'application/json' }));
    const body = await res.json();
    expect(body.onboarding).toBe('https://imajin.ai/.well-known/agent.json');
  });

  it('returns 403 JSON with the jsonError override and reason', async () => {
    const res = respondForbidden(
      makeRequest({ accept: 'application/json' }),
      'Private Asset',
      'This asset is owner-only.',
      'Access denied',
      'owner-only',
    );
    const body = await res.json();
    expect(body.error).toBe('Access denied');
    expect(body.reason).toBe('owner-only');
  });

  it('falls back to htmlMessage for the JSON error when jsonError is omitted', async () => {
    const res = respondForbidden(
      makeRequest({ accept: 'application/json' }),
      'Private Asset',
      'This asset is owner-only.',
    );
    const body = await res.json();
    expect(body.error).toBe('This asset is owner-only.');
  });

  it('returns 403 HTML page for browser clients', async () => {
    const res = respondForbidden(
      makeRequest({ accept: 'text/html' }),
      'Access Restricted',
      'Trust-graph members only.',
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Access Restricted');
    expect(body).toContain('Trust-graph members only.');
  });

  it('omits reason from JSON when not supplied', async () => {
    const res = respondForbidden(makeRequest({ accept: 'application/json' }));
    const body = await res.json();
    expect('reason' in body).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// respondPaymentRequired
// ---------------------------------------------------------------------------

describe('respondPaymentRequired', () => {
  it('returns 402 JSON with the provided body and headers for API clients', async () => {
    const res = respondPaymentRequired(
      makeRequest({ accept: 'application/json' }),
      { schemes: ['mjnx-direct'] },
      { 'X-Payment-Options': 'test' },
    );
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.schemes).toEqual(['mjnx-direct']);
  });

  it('returns 402 HTML page for browser clients', async () => {
    const res = respondPaymentRequired(
      makeRequest({ accept: 'text/html' }),
      {},
    );
    expect(res.status).toBe(402);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Payment Required');
  });
});
