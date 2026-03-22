import { NextRequest } from 'next/server';

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  /** Spoofed client IP (used for rate-limit key) */
  ip?: string;
}

/**
 * Build a NextRequest for route handler invocation.
 * Each call creates a fresh request object.
 */
export function makeRequest(
  pathname: string,
  opts: RequestOptions = {},
): NextRequest {
  const { method = 'GET', body, headers = {}, cookies = {}, ip } = opts;
  const url = `http://localhost${pathname}`;

  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('; ');

  const allHeaders: Record<string, string> = {
    ...(body != null ? { 'Content-Type': 'application/json' } : {}),
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    // Unique IP per request to avoid shared rate-limit state between tests
    'X-Forwarded-For': ip ?? `10.0.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`,
    ...headers,
  };

  return new NextRequest(url, {
    method,
    headers: allHeaders,
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

/** POST shorthand */
export function post(pathname: string, body: unknown, opts: Omit<RequestOptions, 'method' | 'body'> = {}): NextRequest {
  return makeRequest(pathname, { ...opts, method: 'POST', body });
}

/** GET shorthand */
export function get(pathname: string, opts: Omit<RequestOptions, 'method' | 'body'> = {}): NextRequest {
  return makeRequest(pathname, { ...opts, method: 'GET' });
}
