/**
 * Shared `CRON_SECRET` bearer-auth contract for `app/api/cron/*` route tests
 * (#1076 Stage 1).
 *
 * Every cron route gates on the identical `Authorization: Bearer
 * {CRON_SECRET}` check (see `attestation-cleanup`, `quickbooks-reconcile`,
 * `usage-billed-ingest`, etc.), so each route's test file used to hand-copy
 * the same `makeRequest` + cron-secret setup/teardown +
 * missing/wrong-bearer `it()` pair. Declaring it once here is the cron-route
 * counterpart to `describeRouteWiringContract` for connector routes.
 *
 * Call this INSIDE the route's own top-level `describe(...)` block so the
 * `beforeEach`/`afterEach` it registers apply to every sibling `it()` in that
 * describe, exactly as if they had been declared inline.
 */
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _setCronSecretForTests, _resetCronSecretForTests } from '@/src/cron/secret';

export interface CronRouteAuthFixture {
  /** Build a bare `Request` for this route, with optional headers. */
  makeRequest: (headers?: Record<string, string>) => Request;
  /** Invoke the route's `GET` (or other) handler under test. */
  callRoute: (request: Request) => Promise<Response>;
}

/**
 * Pins the fail-closed `CRON_SECRET` bearer-auth gate (#2550): 503 when
 * `CRON_SECRET` is unset or empty (the route must never run open), 401 when the
 * header is missing or wrong while `CRON_SECRET` is set. The secret is pinned via
 * the `_setCronSecretForTests` seam (it is vault-held in production, never an
 * env var); the seam is reset afterward and mocks are cleared between cases,
 * same as every cron route test this was extracted from.
 */
export function describeCronSecretAuthContract(fixture: CronRouteAuthFixture): void {
  const { makeRequest, callRoute } = fixture;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetCronSecretForTests();
  });

  it('fails closed with 503 when CRON_SECRET is unset, even with a bearer header', async () => {
    _setCronSecretForTests(null);
    const response = await callRoute(makeRequest({ authorization: 'Bearer anything' }));
    expect(response.status).toBe(503);
  });

  it('fails closed with 503 when CRON_SECRET is empty', async () => {
    _setCronSecretForTests('');
    const response = await callRoute(makeRequest());
    expect(response.status).toBe(503);
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is missing', async () => {
    _setCronSecretForTests('test-secret');
    const response = await callRoute(makeRequest());
    expect(response.status).toBe(401);
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is wrong', async () => {
    _setCronSecretForTests('test-secret');
    const response = await callRoute(makeRequest({ authorization: 'Bearer wrong-secret' }));
    expect(response.status).toBe(401);
  });
}
