import { vi } from 'vitest';
import { _resetInternalApiKeyStateForTests, setInternalApiKeyResolver } from '../../src/internal-api-key';

/**
 * Shared fixtures for testing packages/auth clients built on `postInternal()`
 * (#2058) — `evaluateEligibility` and `backfillContactEmail` share this same
 * env/fetch-stubbing setup, and duplicating it verbatim in both test files
 * pushed SonarCloud's `new_duplicated_lines_density` over the gate threshold.
 */

export const AUTH_SERVICE_URL = 'https://auth.kernel.test';
export const INTERNAL_API_KEY = 'attestation-internal-key';

/** Parses the JSON body of the first call recorded on a stubbed `fetch` mock. */
export function requestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls[0];
  return JSON.parse(call[1].body as string) as Record<string, unknown>;
}

/** Common `beforeEach` for postInternal()-based client tests. */
export function setUpInternalPostEnv(): void {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
  // Vault-sourced (#2353): the key is injected, never read from process.env.
  _resetInternalApiKeyStateForTests();
  setInternalApiKeyResolver(() => INTERNAL_API_KEY);
  delete process.env.AUTH_INTERNAL_API_KEY;
}

/** Simulates a service whose boot-time vault fetch never resolved a key. */
export function clearInternalApiKey(): void {
  _resetInternalApiKeyStateForTests();
}

/** Common `afterEach` for postInternal()-based client tests. */
export function tearDownInternalPostEnv(): void {
  delete process.env.AUTH_SERVICE_URL;
  _resetInternalApiKeyStateForTests();
  delete process.env.AUTH_INTERNAL_API_KEY;
  vi.unstubAllGlobals();
}
