import { vi, beforeEach, afterEach } from 'vitest';

/**
 * Stubs the registry-resolver env vars (`REGISTRY_SERVICE_URL`,
 * `REGISTRY_URL`, `PORT`) around every test in the current suite and resets
 * the module registry so each test gets a fresh import of the module under
 * test (`registryServiceUrl()`/`hasRegistryServiceUrl()` cache their
 * one-time deprecation warning at module scope). Also clears all mocks
 * between tests.
 *
 * Shared by every #2061 registry-resolver test file — `dfos-relay.test.ts`,
 * and the `notify/api/{interest,broadcast,unsubscribe}/registry.test.ts`
 * suites — so the env save/delete/restore boilerplate isn't copy-pasted
 * per file (Sonar dup gate).
 */
export function stubRegistryResolverEnv(extraKeys: readonly string[] = []): void {
  const keys = ['REGISTRY_SERVICE_URL', 'REGISTRY_URL', 'PORT', ...extraKeys];
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    saved = {};
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });
}
