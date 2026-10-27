import { NextResponse, type NextRequest } from 'next/server';
import { appRedirectUrl, appUrlContext, type AppUrlOptions } from './redirect-url';

export type ForwardAuthCallbackOptions = AppUrlOptions;

/**
 * Consume the kernel's root callback before an app's claim/login gates.
 * Returns null for all other requests, leaving middleware composition to the app.
 */
export function forwardAuthCallback(
  req: NextRequest,
  options: ForwardAuthCallbackOptions = {},
): NextResponse | null {
  const { pathname, searchParams } = req.nextUrl;
  if (!searchParams.get('code') || !searchParams.get('state')) {
    return null;
  }

  const { basePath } = appUrlContext(req, options);
  // Next.js removes its configured basePath from nextUrl.pathname.
  const root = req.nextUrl.basePath === basePath ? '/' : basePath || '/';
  const isRoot = pathname === root || (root !== '/' && pathname === `${root}/`);
  if (!isRoot) {
    return null;
  }

  const callback = appRedirectUrl('/api/auth/callback', req, options);
  callback.search = req.nextUrl.search;
  return NextResponse.redirect(callback, 307);
}
