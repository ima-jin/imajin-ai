/**
 * Shared test scaffolding for the "auth" service's `ATTESTATION_INTERNAL_API_KEY`
 * Bearer-token-gated internal POST routes (#1999/#2053/#1992: `/api/eligibility/evaluate`,
 * `/api/identity/:did/contact`, `/api/credentials/resolve`, ...). Every one of
 * these routes shares the exact same `requireInternalApiKey` caller-authentication
 * contract (`apps/kernel/src/lib/auth/require-internal-api-key.ts`) and the same
 * `Authorization: Bearer <key>` request shape; pinning that shared behavior once
 * here (mirroring the notify app's `internal-route-test-helpers.ts`) keeps each
 * route's own test file focused on what actually differs between routes: its
 * body shape and success-path behavior. Not itself a `*.test.ts` file, so
 * vitest never collects it as a suite on its own (see vitest.config.ts's
 * `include`).
 */
import { describe, it, expect } from 'vitest';
import type { NextRequest } from 'next/server';

const ATTESTATION_INTERNAL_API_KEY_ENV = 'ATTESTATION_INTERNAL_API_KEY';

type PostHandler = (request: NextRequest) => Promise<Response>;

/** Builds a `POST` request carrying a JSON body and an `Authorization: Bearer <key>` header. */
export function makeInternalKeyRequest(body: unknown, apiKey: string | undefined): NextRequest {
  const headers = new Headers();
  if (apiKey !== undefined) headers.set('authorization', `Bearer ${apiKey}`);
  return { headers, json: async () => body } as unknown as NextRequest;
}

/**
 * Pins the shared caller-authentication contract: a missing/wrong key, and an
 * unset server-side key, both 401 before the route ever reaches its delegate
 * (a DB read, a forwarded request, ...). `assertNoSideEffect` lets each route
 * assert on its own delegate mock (e.g. `expect(mockDbSelect).not.toHaveBeenCalled()`).
 */
export function describeInternalApiKeyAuth(params: {
  routeLabel: string;
  post: PostHandler;
  apiKey: string;
  validBody: unknown;
  assertNoSideEffect?: () => void;
}): void {
  const { routeLabel, post, apiKey, validBody, assertNoSideEffect } = params;

  describe(`${routeLabel} — caller authentication (${ATTESTATION_INTERNAL_API_KEY_ENV})`, () => {
    it('rejects when the API key is missing or wrong', async () => {
      const res = await post(makeInternalKeyRequest(validBody, 'wrong-key'));

      expect(res.status).toBe(401);
      assertNoSideEffect?.();
    });

    it(`rejects when ${ATTESTATION_INTERNAL_API_KEY_ENV} is not configured server-side`, async () => {
      delete process.env[ATTESTATION_INTERNAL_API_KEY_ENV];
      const res = await post(makeInternalKeyRequest(validBody, apiKey));

      expect(res.status).toBe(401);
    });
  });
}
