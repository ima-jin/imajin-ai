import { beforeEach, afterEach, vi } from "vitest";

/**
 * Stubs the given env vars (saving/restoring their original values) and
 * `global.fetch` around every test in the current suite. Shared by every
 * `*_SERVICE_URL`-based SDK function test (`getNodeSelf`,
 * `getForestScopeConfig`, ...) so the env/fetch stubbing boilerplate isn't
 * copy-pasted per function — call this once inside a `describe(...)` block
 * and read `.fetchMock` from the returned handle in each `it(...)`.
 */
export function useStubbedServiceEnv(envKeys: readonly string[]): { fetchMock: ReturnType<typeof vi.fn> } {
  const handle = { fetchMock: vi.fn() };
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of envKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    handle.fetchMock = vi.fn();
    vi.stubGlobal("fetch", handle.fetchMock);
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  return handle;
}
