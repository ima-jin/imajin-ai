/**
 * Shared `CRON_SECRET` bearer-auth contract for `app/api/cron/*` route tests
 * (#1076 Stage 1).
 *
 * Every cron route gates on the identical `Authorization: Bearer
 * {CRON_SECRET}` check (see `attestation-cleanup`, `quickbooks-reconcile`,
 * `usage-billed-ingest`, etc.), so each route's test file used to hand-copy
 * the same `makeRequest` + `originalCronSecret` save/restore +
 * missing/wrong-bearer `it()` pair. Declaring it once here is the cron-route
 * counterpart to `describeRouteWiringContract` for connector routes.
 *
 * Call this INSIDE the route's own top-level `describe(...)` block so the
 * `beforeEach`/`afterEach` it registers apply to every sibling `it()` in that
 * describe, exactly as if they had been declared inline.
 */
import { it, expect, beforeEach, afterEach, vi } from 'vitest';

export interface CronRouteAuthFixture {
  /** Build a bare `Request` for this route, with optional headers. */
  makeRequest: (headers?: Record<string, string>) => Request;
  /** Invoke the route's `GET` (or other) handler under test. */
  callRoute: (request: Request) => Promise<Response>;
}

/**
 * Pins the `CRON_SECRET` bearer-auth gate: 401 when the header is missing or
 * wrong while `CRON_SECRET` is set. Restores the pre-test `CRON_SECRET` value
 * afterward and clears mocks between cases, same as every cron route test
 * this was extracted from.
 */
export function describeCronSecretAuthContract(fixture: CronRouteAuthFixture): void {
  const { makeRequest, callRoute } = fixture;
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is missing', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const response = await callRoute(makeRequest());
    expect(response.status).toBe(401);
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is wrong', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const response = await callRoute(makeRequest({ authorization: 'Bearer wrong-secret' }));
    expect(response.status).toBe(401);
  });
}
