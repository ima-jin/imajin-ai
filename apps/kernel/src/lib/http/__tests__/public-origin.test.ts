import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { forwardedOrigin, proxyAwarePublicOrigin, publicOrigin } from '../public-origin';

/**
 * #1608 — behind Caddy, request.url is Next's internal fallback origin
 * (http://localhost:3000), so browser-facing redirects MUST be anchored to a
 * trusted configured origin instead.
 */

const INTERNAL_URL = 'http://localhost:3000/media/api/assets/asset_abc';

function makeRequest(url = INTERNAL_URL): NextRequest {
  return new Request(url) as unknown as NextRequest;
}

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

describe('publicOrigin', () => {
  it('prefers the runtime APP_URL over everything else', () => {
    process.env.APP_URL = 'https://jin.imajin.ai';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://stale.imajin.ai';
    expect(publicOrigin(makeRequest())).toBe('https://jin.imajin.ai');
  });

  it('falls back to NEXT_PUBLIC_BASE_URL when APP_URL is unset', () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://dev-jin.imajin.ai';
    expect(publicOrigin(makeRequest())).toBe('https://dev-jin.imajin.ai');
  });

  it('falls back to the request origin for local dev (no env configured)', () => {
    expect(publicOrigin(makeRequest())).toBe('http://localhost:3000');
  });

  it('strips a configured path so redirects land at the node root', () => {
    process.env.APP_URL = 'https://jin.imajin.ai/chat';
    expect(publicOrigin(makeRequest())).toBe('https://jin.imajin.ai');
  });

  it('strips a trailing slash', () => {
    process.env.APP_URL = 'https://jin.imajin.ai/';
    expect(publicOrigin(makeRequest())).toBe('https://jin.imajin.ai');
  });

  it('keeps an explicitly configured non-default port', () => {
    process.env.APP_URL = 'http://localhost:7000';
    expect(publicOrigin(makeRequest())).toBe('http://localhost:7000');
  });

  it('ignores an unparseable configured value and falls through', () => {
    process.env.APP_URL = 'not-a-url';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://jin.imajin.ai';
    expect(publicOrigin(makeRequest())).toBe('https://jin.imajin.ai');
  });

  it('ignores an empty configured value and falls through', () => {
    process.env.APP_URL = '';
    expect(publicOrigin(makeRequest())).toBe('http://localhost:3000');
  });

  it('never trusts the Host / X-Forwarded-Host headers (open-redirect guard)', () => {
    const request = new Request(INTERNAL_URL, {
      headers: { host: 'evil.example.com', 'x-forwarded-host': 'evil.example.com' },
    }) as unknown as NextRequest;
    expect(publicOrigin(request)).toBe('http://localhost:3000');
  });
});

/**
 * #2363 — the connector OAuth callback has no configured origin to fall back
 * on in every deployment, so it reads the proxy's forwarded headers before
 * settling for the upstream `request.url`.
 */
function proxied(headers: Record<string, string>): NextRequest {
  return new Request(INTERNAL_URL, { headers }) as unknown as NextRequest;
}

describe('forwardedOrigin', () => {
  it('defaults to https when only the host was forwarded', () => {
    expect(forwardedOrigin(proxied({ 'x-forwarded-host': 'jin.imajin.ai' }))).toBe('https://jin.imajin.ai');
  });

  it('honours an explicit http proto', () => {
    const request = proxied({ 'x-forwarded-host': 'jin.imajin.ai', 'x-forwarded-proto': 'http' });
    expect(forwardedOrigin(request)).toBe('http://jin.imajin.ai');
  });

  it('keeps a forwarded non-default port', () => {
    expect(forwardedOrigin(proxied({ 'x-forwarded-host': 'jin.imajin.ai:8443' }))).toBe('https://jin.imajin.ai:8443');
  });

  it('takes the outermost hop from a comma-joined chain', () => {
    const request = proxied({
      'x-forwarded-host': 'jin.imajin.ai, inner.internal',
      'x-forwarded-proto': 'https, http',
    });
    expect(forwardedOrigin(request)).toBe('https://jin.imajin.ai');
  });

  it('returns null when no host was forwarded', () => {
    expect(forwardedOrigin(proxied({}))).toBeNull();
  });

  it.each([
    { label: 'a scheme', host: 'https://evil.example.com' },
    { label: 'a path', host: 'jin.imajin.ai/../evil.example.com' },
    { label: 'userinfo', host: 'jin.imajin.ai@evil.example.com' },
    { label: 'whitespace', host: 'jin.imajin.ai evil.example.com' },
    { label: 'nothing at all', host: '' },
  ])('rejects a forwarded host carrying $label', ({ host }) => {
    expect(forwardedOrigin(proxied({ 'x-forwarded-host': host }))).toBeNull();
  });
});

describe('proxyAwarePublicOrigin', () => {
  it('still prefers a configured origin over the forwarded headers', () => {
    process.env.APP_URL = 'https://configured.imajin.ai';
    expect(proxyAwarePublicOrigin(proxied({ 'x-forwarded-host': 'jin.imajin.ai' }))).toBe(
      'https://configured.imajin.ai',
    );
  });

  it('uses the forwarded host when nothing is configured', () => {
    expect(proxyAwarePublicOrigin(proxied({ 'x-forwarded-host': 'jin.imajin.ai' }))).toBe('https://jin.imajin.ai');
  });

  it('falls back to the request origin with neither config nor proxy headers', () => {
    expect(proxyAwarePublicOrigin(proxied({}))).toBe('http://localhost:3000');
  });
});
