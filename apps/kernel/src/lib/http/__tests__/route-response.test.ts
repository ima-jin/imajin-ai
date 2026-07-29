import { describe, it, expect } from 'vitest';
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
// respondForbidden
// ---------------------------------------------------------------------------

describe('respondForbidden', () => {
  it('returns 403 JSON with error for API clients', async () => {
    const res = respondForbidden(makeRequest({ accept: 'application/json' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBeTruthy();
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
