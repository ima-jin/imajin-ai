import { NextResponse } from 'next/server';

/** Drizzle wraps driver failures in `cause`; preserve acquire and query deadlines. */
export function isDatabaseTimeout(error: unknown): boolean {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (error.name === 'DatabaseTimeoutError' && 'code' in error
      && (error.code === 'DB_ACQUIRE_TIMEOUT' || error.code === 'DB_QUERY_TIMEOUT')) return true;
    error = error.cause;
  }
  return false;
}

export function databaseTimeoutResponse(error: unknown, headers: Record<string, string>) {
  if (!isDatabaseTimeout(error)) return undefined;
  return NextResponse.json(
    { error: 'Database temporarily unavailable' },
    { status: 503, headers: { ...headers, 'Retry-After': '5', 'Cache-Control': 'no-store' } },
  );
}
