import { vi } from 'vitest';

/**
 * Shared `vi.mock('next/server', ...)` factory + `makeRequest` helper (#2144
 * dedup). Nearly every connector route-wiring test hand-copies the identical
 * `NextResponse.json` / `NextResponse.redirect` stub and a bare-object
 * `makeRequest(url, headers)` helper — this is the shared version.
 *
 * Usage (the arrow-function wrapper is required — see
 * `scope-manifest-core-mock.ts`'s doc comment for why a bare imported
 * reference passed directly as vi.mock's second argument throws a TDZ error):
 *
 *   vi.mock('next/server', () => nextServerMockFactory());
 */
export function nextServerMockFactory() {
  return {
    NextResponse: {
      json: vi.fn((body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body })),
      redirect: vi.fn((url: string | URL) => ({ status: 307, headers: { location: String(url) } })),
    },
    NextRequest: class {},
  };
}

/** Build a bare request-like object for a route handler under test. */
export function makeRequest(url: string, headers: Record<string, string> = {}) {
  return { url, headers: new Headers(headers) } as unknown as import('next/server').NextRequest;
}
