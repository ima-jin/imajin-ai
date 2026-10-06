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
import { describe, it, expect, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const ATTESTATION_INTERNAL_API_KEY_LABEL = 'ATTESTATION_INTERNAL_API_KEY';

/**
 * Stand-in for `@/src/lib/vault/internal-secret` — the ONLY source of the
 * expected key (#2353 step 4: no `process.env` fallback). Route tests install
 * it with:
 *
 *   vi.mock('@/src/lib/vault/internal-secret', async () =>
 *     (await import('@/app/auth/api/__tests__/internal-api-key-auth-test-support')).internalSecretModuleMock);
 */
export const internalSecretModuleMock = { getInternalSecret: vi.fn() };

/** Seeds the vault-resolved key, or (with `undefined`) simulates a vault with no value for it. */
export function useVaultInternalKey(key: string | undefined): void {
  if (key === undefined) {
    internalSecretModuleMock.getInternalSecret.mockReset().mockRejectedValue(new Error('no vault value'));
  } else {
    internalSecretModuleMock.getInternalSecret.mockReset().mockResolvedValue(key);
  }
}

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

  describe(`${routeLabel} — caller authentication (${ATTESTATION_INTERNAL_API_KEY_LABEL})`, () => {
    it('rejects when the API key is missing or wrong', async () => {
      useVaultInternalKey(apiKey);
      const res = await post(makeInternalKeyRequest(validBody, 'wrong-key'));

      expect(res.status).toBe(401);
      assertNoSideEffect?.();
    });

    it(`fails closed (401) when the vault has no ${ATTESTATION_INTERNAL_API_KEY_LABEL} value`, async () => {
      useVaultInternalKey(undefined);
      const res = await post(makeInternalKeyRequest(validBody, apiKey));

      expect(res.status).toBe(401);
      assertNoSideEffect?.();
    });

    it(`ignores a hand-set ${ATTESTATION_INTERNAL_API_KEY_LABEL} env var when the vault has no value (#2353 step 4)`, async () => {
      useVaultInternalKey(undefined);
      process.env.ATTESTATION_INTERNAL_API_KEY = apiKey;
      try {
        const res = await post(makeInternalKeyRequest(validBody, apiKey));

        expect(res.status).toBe(401);
      } finally {
        delete process.env.ATTESTATION_INTERNAL_API_KEY;
      }
    });
  });
}
