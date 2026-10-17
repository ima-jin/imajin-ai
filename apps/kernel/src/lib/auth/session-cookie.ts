import { NextResponse } from 'next/server';
import { getSessionCookieOptions } from '@imajin/config';

/**
 * Finalize a session response, migrating the other deployed cookie scope.
 *
 * Call after ALL other response.cookies mutations. Next's ResponseCookies map
 * keys by name, not (name, domain, path), so two cookies.set calls would silently
 * drop one scope. Serialize separately and append real Set-Cookie headers.
 * Reads remain unchanged: a legacy-only session survives until its next write.
 * null clears both scopes, including on invalid-session responses.
 */
export function withSessionCookie(
  response: NextResponse,
  token: string | null,
  config = getSessionCookieOptions(),
): NextResponse {
  const { name, options } = config;
  const active = new NextResponse();
  active.cookies.set(name, token ?? '', { ...options, ...(token === null ? { maxAge: 0 } : {}) });
  response.headers.append('set-cookie', active.headers.get('set-cookie')!);

  // Local HTTP has never had a parent-domain cookie.
  if (options.secure) {
    const { domain: _domain, ...hostOptions } = options;
    const otherScope = options.domain ? hostOptions : { ...hostOptions, domain: '.imajin.ai' };
    const expired = new NextResponse();
    expired.cookies.set(name, '', { ...otherScope, maxAge: 0, expires: new Date(0) });
    response.headers.append('set-cookie', expired.headers.get('set-cookie')!);
  }
  return response;
}
