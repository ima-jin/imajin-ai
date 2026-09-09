/**
 * Shared test scaffolding for the notify app's internal-key-authenticated
 * routes (`.../internal/ack`, `.../internal/release`, #2099). Every one of
 * these routes shares the exact same caller-authentication contract
 * (`requireInternalKey`) and JSON-body-parsing contract (`parseJsonBody`,
 * both in `@/src/lib/notify/internal-route-guards`); pinning that shared
 * behavior once here keeps each route's own test file focused on what
 * actually differs between routes: its required field(s) and its delegate
 * call. Not itself a `*.test.ts` file, so vitest never collects it as a
 * suite on its own (see `vitest.config.ts`'s `include`).
 */
import { describe, it, expect } from 'vitest';

type PostHandler = (request: Request) => Promise<Response>;
type RequestOptions = { key?: string | null };

/** Builds a `POST {endpoint}` request, defaulting to a valid internal key. */
export function makeRequestFactory(endpoint: string, defaultKey: string) {
  return (body: string, { key = defaultKey as string | null }: RequestOptions = {}): Request => {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (key !== null) headers.set('x-internal-key', key);
    return new Request(endpoint, { method: 'POST', headers, body });
  };
}

/** A mock whose call count this helper can assert on, without depending on its argument types. */
type AnyMock = { mock: { calls: unknown[][] } };

/**
 * Pins the shared caller-authentication contract: no header, the wrong key,
 * and an unset `AUTH_INTERNAL_API_KEY` (fail closed, never "any caller
 * matches undefined") all 401 without ever reaching the route's delegate.
 */
export function describeInternalKeyAuth(params: {
  routeLabel: string;
  post: PostHandler;
  makeRequest: ReturnType<typeof makeRequestFactory>;
  validBody: unknown;
  delegateMock: AnyMock;
  setInternalKey: (key: string | undefined) => void;
}) {
  const { routeLabel, post, makeRequest, validBody, delegateMock, setInternalKey } = params;

  describe(`${routeLabel} — caller authentication`, () => {
    it('rejects a request with no x-internal-key header', async () => {
      const res = await post(makeRequest(JSON.stringify(validBody), { key: null }));

      expect(res.status).toBe(401);
      expect(delegateMock.mock.calls).toHaveLength(0);
    });

    it('rejects a request with the wrong key', async () => {
      const res = await post(makeRequest(JSON.stringify(validBody), { key: 'nope' }));

      expect(res.status).toBe(401);
      expect(delegateMock.mock.calls).toHaveLength(0);
    });

    it('rejects every caller when AUTH_INTERNAL_API_KEY is unset', async () => {
      setInternalKey(undefined);

      const res = await post(makeRequest(JSON.stringify(validBody), { key: null }));

      expect(res.status).toBe(401);
      expect(delegateMock.mock.calls).toHaveLength(0);
    });
  });
}

/**
 * Pins the shared request-body contract: malformed JSON 400s, and each
 * `[label, body]` case the caller supplies 400s without reaching the
 * route's delegate. The route-specific required field(s) are exactly what
 * varies between routes, so those cases are supplied by the caller rather
 * than hardcoded here.
 */
export function describeJsonBodyValidation(params: {
  routeLabel: string;
  post: PostHandler;
  makeRequest: ReturnType<typeof makeRequestFactory>;
  invalidCases: Array<[string, unknown]>;
  delegateMock: AnyMock;
}) {
  const { routeLabel, post, makeRequest, invalidCases, delegateMock } = params;

  describe(`${routeLabel} — request body`, () => {
    it('rejects a malformed JSON body', async () => {
      const res = await post(makeRequest('{ not json'));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid JSON' });
    });

    it.each(invalidCases)('rejects %s with 400', async (_label, body) => {
      const res = await post(makeRequest(JSON.stringify(body)));

      expect(res.status).toBe(400);
      expect(delegateMock.mock.calls).toHaveLength(0);
    });
  });
}
