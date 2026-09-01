/**
 * Shared test support for connector model-picker route tests (#1928).
 *
 * `createConnectorModelPickerRoute` gives every token-paste connector's
 * GET/PUT/OPTIONS model picker the same contract, so the request/fetch
 * stubbing and mock-reset boilerplate that exercises it is declared once
 * here rather than copied into every connector's route test.
 */
import { vi } from 'vitest';

/** The minimal request shape a model-picker route's GET/PUT handlers read. */
export interface ModelPickerRouteRequest {
  headers: Headers;
  json: () => Promise<unknown>;
}

/**
 * Build a request stub for a model-picker route handler.
 *
 * `malformed` simulates a body whose `.json()` rejects, exercising the
 * "Invalid JSON body" (400) path without needing a real malformed payload.
 */
export function makeModelPickerRequest(
  body?: unknown,
  opts: { malformed?: boolean } = {},
): ModelPickerRouteRequest {
  return {
    headers: new Headers(),
    json: async () => {
      if (opts.malformed === true) throw new Error('invalid json');
      return body;
    },
  };
}

/** Stub `global.fetch` with a single canned upstream response. */
export function stubModelPickerFetch(
  body: unknown,
  ok = true,
  status = 200,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The four mocks every model-picker route test resets between cases. */
export interface ModelPickerRouteMocks {
  resolveOwnerDid: ReturnType<typeof vi.fn>;
  loadSealedCredentials: ReturnType<typeof vi.fn>;
  keyPending: ReturnType<typeof vi.fn>;
  setModelId: ReturnType<typeof vi.fn>;
  ownerDid: string;
  apiKey: string;
}

/**
 * Reset a model-picker route's mocks to the "happy path" defaults: auth
 * succeeds, a key is sealed, no grant is pending, and sealing a model
 * succeeds. Individual tests override one mock's return value as needed.
 */
export function resetModelPickerMocks(mocks: ModelPickerRouteMocks): void {
  vi.unstubAllGlobals();
  mocks.resolveOwnerDid.mockReset();
  mocks.resolveOwnerDid.mockResolvedValue({ ok: true, ownerDid: mocks.ownerDid });
  mocks.loadSealedCredentials.mockReset();
  mocks.loadSealedCredentials.mockResolvedValue({ apiKey: mocks.apiKey });
  mocks.keyPending.mockReset();
  mocks.keyPending.mockResolvedValue(false);
  mocks.setModelId.mockReset();
  mocks.setModelId.mockResolvedValue(undefined);
}
