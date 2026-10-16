import type { NextRequest } from 'next/server';

export interface AppUrlOptions {
  /** Public app URL, including its basePath (preferred behind a reverse proxy). */
  publicUrl?: string;
  /** App basePath; defaults to the public URL pathname or Next.js basePath. */
  basePath?: string;
}

function normalizeBasePath(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') {
    end -= 1;
  }
  return path.slice(0, end);
}

/** Shared by middleware and route handlers so their public destinations agree. */
export function appUrlContext(req: NextRequest, options: AppUrlOptions) {
  const publicUrl = options.publicUrl ? new URL(options.publicUrl) : null;
  const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0].trim();
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim();
  let origin = req.nextUrl.origin;
  if (publicUrl) {
    origin = publicUrl.origin;
  } else if (forwardedHost) {
    origin = `${forwardedProto || req.nextUrl.protocol.slice(0, -1)}://${forwardedHost}`;
  }

  const publicPath = publicUrl ? normalizeBasePath(publicUrl.pathname) : '';
  const basePath = normalizeBasePath(options.basePath ?? (publicPath || req.nextUrl.basePath));
  return { origin, basePath };
}

export function appRedirectUrl(path: string, req: NextRequest, options: AppUrlOptions): URL {
  const { origin, basePath } = appUrlContext(req, options);
  // Absolute (including protocol-relative) targets retain their existing meaning.
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//')) {
    return new URL(path, origin);
  }

  const appPath = path.startsWith('/') ? path : `/${path}`;
  const target = new URL(appPath, origin);
  const alreadyPrefixed = target.pathname === basePath || target.pathname.startsWith(`${basePath}/`);
  if (basePath && !alreadyPrefixed) {
    target.pathname = `${basePath}${target.pathname}`;
  }
  return target;
}
