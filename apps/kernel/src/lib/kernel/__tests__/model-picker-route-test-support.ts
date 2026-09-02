/**
 * Shared test support for connector model-picker route tests (#1928).
 *
 * `createConnectorModelPickerRoute` gives every token-paste connector's
 * GET/PUT/OPTIONS model picker the same contract, so the request/fetch
 * stubbing and mock-reset boilerplate that exercises it is declared once
 * here rather than copied into every connector's route test.
 *
 * `describeModelPickerRouteContract` (#1927) goes one step further and
 * declares the whole behavioural suite once too — xAI (#1924) and OpenAI
 * (#1927) both hand-copied the full auth/credential-state/GET/PUT contract
 * down to the assertion prose, differing only in the provider's base URL,
 * sample model ids and display name. The next OpenAI-compatible provider
 * with a model picker (#1930, #1931) gets this whole suite for the price of
 * one fixture instead of another 250-line copy.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

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

export interface ModelPickerRouteDeps {
  resolveOwnerDid: Mock;
}

/**
 * Mock the three dependencies every model-picker route shares regardless of
 * provider — `resolveConnectorOwnerDid`, CORS headers, and the logger — via
 * `vi.doMock` (unlike `vi.mock`, NOT hoisted, so it registers only for the
 * NEXT dynamic import). Call this BEFORE mocking the connector-specific
 * module and dynamically importing the route under test:
 *
 * ```ts
 * const { resolveOwnerDid } = mockModelPickerRouteDeps();
 * vi.doMock('@/src/lib/openai/connector', () => ({ ... }));
 * const { GET, PUT, OPTIONS } = await import('../route');
 * ```
 */
export function mockModelPickerRouteDeps(): ModelPickerRouteDeps {
  const resolveOwnerDid = vi.fn();

  vi.doMock('@/src/lib/kernel/connector-owner-did', () => ({
    resolveConnectorOwnerDid: resolveOwnerDid,
  }));

  vi.doMock('@/src/lib/kernel/cors', () => ({
    corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.imajin.ai' }),
    corsOptions: () => new Response(null, { status: 204 }),
  }));

  vi.doMock('@imajin/logger', () => ({
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  }));

  return { resolveOwnerDid };
}

export interface ModelPickerRouteContractFixture<Req = ModelPickerRouteRequest> {
  /** Display name used in owner-facing prose, e.g. `'OpenAI'`. */
  label: string;
  /** Lowercase connector id, e.g. `'openai'` — drives the `${id}_*` error codes. */
  id: string;
  /** The connector's default upstream base URL, e.g. `'https://api.openai.com/v1'`. */
  baseUrl: string;
  ownerDid: string;
  apiKey: string;
  /** Two believable model ids this provider actually serves. */
  sampleModelIds: readonly [string, string];
  /** A model id used to exercise the "provider no longer serves this" (404) path. */
  deprecatedModelId: string;
  /** The route's real GET/PUT/OPTIONS handlers — `Req` is inferred as their actual request type. */
  GET: (request: Req) => Promise<Response>;
  PUT: (request: Req) => Promise<Response>;
  OPTIONS: (request: Req) => Promise<Response>;
  mocks: {
    resolveOwnerDid: Mock;
    loadSealed: Mock;
    keyPending: Mock;
    setModelId: Mock;
  };
}

export interface ModelPickerAuthAndValidationMocks {
  resolveOwnerDid: Mock;
  loadSealedCredentials: Mock;
  keyPending: Mock;
  setModelId: Mock;
}

export interface ModelPickerAuthAndValidationFixture<Req = ModelPickerRouteRequest> {
  /** Lowercase connector id — drives the `${id}_no_key` / `${id}_credential_pending` error regexes. */
  id: string;
  GET: (request: Req) => Promise<Response>;
  PUT: (request: Req) => Promise<Response>;
  OPTIONS: (request: Req) => Promise<Response>;
  makeReq: (body?: unknown, opts?: { malformed?: boolean }) => Req;
  mocks: ModelPickerAuthAndValidationMocks;
  /** A believable model id, used only to exercise auth/validation paths — never asserted on its own. */
  sampleModelId: string;
  /**
   * When supplied, the two upstream-failure PUT cases additionally assert the
   * sealed key never appears in the response body. Omit for a route whose
   * own tests already cover this (e.g. via a GET-side key-leak assertion).
   */
  apiKey?: string;
}

/**
 * Pins the auth/credential-state/validation contract every model-picker
 * route shares regardless of the upstream provider's own list/probe shape
 * (#1953): the auth failure short-circuit, CORS pre-flight, the GET
 * `${id}_no_key`/`${id}_credential_pending` states, PUT body validation
 * (malformed JSON, missing/blank/non-string `modelId`), PUT's own
 * `${id}_no_key`/`${id}_credential_pending` states, the 404→`model_deprecated`
 * (422) mapping, and the non-404/network-failure→502 mappings.
 *
 * Gemini (#1769) and Anthropic (#1953) both hand-declare `listModels`/
 * `probeModel` because their upstream shapes are not OpenAI-compatible, but
 * this SLICE of their route contract — everything upstream of actually
 * calling the provider — is identical to every other model picker, and had
 * been hand-copied between their two test files down to the assertion prose
 * (#1953 flagged 93 duplicated lines between them). Declaring it once here,
 * parameterized on the route's own handlers/mocks, is the OpenAI-compatible
 * providers' `describeModelPickerRouteContract` treatment applied to the
 * bespoke-shape providers' shared slice instead of their whole contract.
 */
export function describeModelPickerAuthAndValidationContract<Req>(
  fixture: ModelPickerAuthAndValidationFixture<Req>,
): void {
  const { id, GET, PUT, OPTIONS, makeReq, mocks, sampleModelId, apiKey } = fixture;

  function expectNoLeak(body: unknown): void {
    if (apiKey !== undefined) {
      expect(JSON.stringify(body)).not.toContain(apiKey);
    }
  }

  describe('every verb is authenticated', () => {
    it.each([
      ['GET', GET],
      ['PUT', PUT],
    ])('returns the auth failure from %s without touching credentials', async (_verb, handler) => {
      mocks.resolveOwnerDid.mockResolvedValueOnce({ ok: false, error: 'Unauthorized', status: 401 });

      const res = await handler(makeReq({ modelId: sampleModelId }));

      expect(res.status).toBe(401);
      expect(mocks.loadSealedCredentials).not.toHaveBeenCalled();
      expect(mocks.setModelId).not.toHaveBeenCalled();
    });

    it('answers CORS pre-flight', async () => {
      const res = await OPTIONS(makeReq());
      expect(res.status).toBe(204);
    });
  });

  describe('credential states', () => {
    it(`returns 400 ${id}_no_key when no key is sealed for this identity`, async () => {
      mocks.loadSealedCredentials.mockResolvedValue(undefined);

      const res = await GET(makeReq());

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(new RegExp(`${id}_no_key`));
    });

    it(`returns 409 ${id}_credential_pending when the key is sealed but awaiting owner grant approval (#1773)`, async () => {
      mocks.loadSealedCredentials.mockResolvedValue(undefined);
      mocks.keyPending.mockResolvedValue(true);

      const res = await GET(makeReq());

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(new RegExp(`${id}_credential_pending`));
    });
  });

  describe('PUT validation and credential states', () => {
    it('returns 400 on malformed JSON', async () => {
      const res = await PUT(makeReq(undefined, { malformed: true }));

      expect(res.status).toBe(400);
      expect(mocks.setModelId).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', {}],
      ['blank', { modelId: '   ' }],
      ['non-string', { modelId: 42 }],
    ])('returns 400 when modelId is %s', async (_label, body) => {
      const res = await PUT(makeReq(body));

      expect(res.status).toBe(400);
      expect(mocks.setModelId).not.toHaveBeenCalled();
    });

    it(`returns 400 ${id}_no_key when no key is sealed, without probing`, async () => {
      mocks.loadSealedCredentials.mockResolvedValue(undefined);
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const res = await PUT(makeReq({ modelId: sampleModelId }));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(new RegExp(`${id}_no_key`));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.setModelId).not.toHaveBeenCalled();
    });

    it(`returns 409 ${id}_credential_pending when the key is sealed but awaiting grant approval`, async () => {
      mocks.loadSealedCredentials.mockResolvedValue(undefined);
      mocks.keyPending.mockResolvedValue(true);

      const res = await PUT(makeReq({ modelId: sampleModelId }));

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(new RegExp(`${id}_credential_pending`));
      expect(mocks.setModelId).not.toHaveBeenCalled();
    });

    it('rejects a retired model with 422 model_deprecated when the probe 404s, without sealing it', async () => {
      stubModelPickerFetch({ error: 'not found' }, false, 404);

      const res = await PUT(makeReq({ modelId: sampleModelId }));
      const body = await res.json() as { error: string; modelId: string };

      expect(res.status).toBe(422);
      expect(body.error).toBe('model_deprecated');
      expect(body.modelId).toBe(sampleModelId);
      expect(mocks.setModelId).not.toHaveBeenCalled();
    });

    it('maps a non-404 probe failure to 502, without sealing the model', async () => {
      stubModelPickerFetch({ error: 'rate limited' }, false, 429);

      const res = await PUT(makeReq({ modelId: sampleModelId }));

      expect(res.status).toBe(502);
      expectNoLeak(await res.json());
      expect(mocks.setModelId).not.toHaveBeenCalled();
    });

    it('maps a network failure during the probe to 502, without sealing the model', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

      const res = await PUT(makeReq({ modelId: sampleModelId }));

      expect(res.status).toBe(502);
      expect(mocks.setModelId).not.toHaveBeenCalled();
    });
  });
}

/**
 * Pins the route CONTRACT for a connector's GET/PUT `/api/models` model
 * picker (#1927):
 *   - the sealed key rides the Authorization header and never reaches the
 *     browser, in either direction;
 *   - listing works before the owner has granted `${id}:infer` (#1773);
 *   - a model the provider will not serve is refused BEFORE it is sealed, so
 *     the card cannot commit a selection that only fails later at inference
 *     time;
 *   - upstream failures surface as a status, never as an upstream body.
 *
 * The vault behaviour behind `loadSealedCredentials` / `keyPending` /
 * `setModelId` is covered by the token-paste factory's own tests; this is
 * route-contract only.
 */
export function describeModelPickerRouteContract<Req>(fixture: ModelPickerRouteContractFixture<Req>): void {
  const {
    label, id, baseUrl, ownerDid, apiKey, sampleModelIds, deprecatedModelId, GET, PUT, OPTIONS, mocks,
  } = fixture;
  const [modelA, modelB] = sampleModelIds;

  function makeReq(body?: unknown, opts: { malformed?: boolean } = {}): Req {
    return makeModelPickerRequest(body, opts) as unknown as Req;
  }

  function stubFetch(body: unknown, ok = true, status = 200) {
    return stubModelPickerFetch(body, ok, status);
  }

  beforeEach(() => {
    resetModelPickerMocks({
      resolveOwnerDid: mocks.resolveOwnerDid,
      loadSealedCredentials: mocks.loadSealed,
      keyPending: mocks.keyPending,
      setModelId: mocks.setModelId,
      ownerDid,
      apiKey,
    });
  });

  // ── Auth ─────────────────────────────────────────────────────────────────────────

  describe('authentication', () => {
    it.each([
      ['GET', GET],
      ['PUT', PUT],
    ])('returns the auth failure from %s without touching the vault', async (_verb, handler) => {
      mocks.resolveOwnerDid.mockResolvedValueOnce({ ok: false, error: 'Unauthorized', status: 401 });

      const res = await handler(makeReq({ modelId: modelA }));

      expect(res.status).toBe(401);
      expect(mocks.loadSealed).not.toHaveBeenCalled();
      expect(mocks.setModelId).not.toHaveBeenCalled();
    });

    it('answers CORS pre-flight', async () => {
      expect((await OPTIONS(makeReq())).status).toBe(204);
    });
  });

  // ── Credential states ──────────────────────────────────────────────────────────

  describe('credential states', () => {
    it(`reports ${id}_no_key when nothing is sealed yet`, async () => {
      mocks.loadSealed.mockResolvedValue(undefined);

      const res = await GET(makeReq());

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(new RegExp(`${id}_no_key`));
    });

    it('distinguishes a key awaiting Tier 1 approval from no key at all', async () => {
      mocks.loadSealed.mockResolvedValue(undefined);
      mocks.keyPending.mockResolvedValue(true);

      const res = await GET(makeReq());

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(new RegExp(`${id}_credential_pending`));
    });

    it(`lists models before any ${id}:infer grant exists (#1773)`, async () => {
      stubFetch({ data: [] });

      const res = await GET(makeReq());

      expect(res.status).toBe(200);
      // The pending probe is only consulted when nothing resolved.
      expect(mocks.keyPending).not.toHaveBeenCalled();
    });
  });

  // ── GET ─────────────────────────────────────────────────────────────────────────

  describe('GET', () => {
    it('sends the key as a bearer token and never returns it', async () => {
      const fetchMock = stubFetch({ data: [{ id: modelA }, { id: modelB }] });

      const res = await GET(makeReq());
      const body = await res.json() as { models: { id: string; name: string }[]; currentModelId: string | null };

      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/models`,
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: `Bearer ${apiKey}` }),
        }),
      );
      expect(body.models).toEqual([
        { id: modelA, name: modelA },
        { id: modelB, name: modelB },
      ]);
      expect(JSON.stringify(body)).not.toContain(apiKey);
    });

    it('drops malformed entries rather than offering a nameless model', async () => {
      stubFetch({ data: [{ id: modelA }, {}, { id: '' }] });

      const body = await (await GET(makeReq())).json() as { models: { id: string }[] };

      expect(body.models).toEqual([{ id: modelA, name: modelA }]);
    });

    it('reports the currently sealed model alongside the list', async () => {
      mocks.loadSealed.mockResolvedValue({ apiKey, modelId: modelA });
      stubFetch({ data: [] });

      expect((await (await GET(makeReq())).json()).currentModelId).toBe(modelA);
    });

    it('honours a sealed baseUrl override instead of the default endpoint', async () => {
      mocks.loadSealed.mockResolvedValue({ apiKey, baseUrl: 'https://proxy.example/v1' });
      const fetchMock = stubFetch({ data: [] });

      await GET(makeReq());

      expect(fetchMock).toHaveBeenCalledWith('https://proxy.example/v1/models', expect.any(Object));
    });

    it('maps an upstream error to 502 without forwarding its body', async () => {
      stubFetch({ error: `bad key ${apiKey}` }, false, 401);

      const res = await GET(makeReq());

      expect(res.status).toBe(502);
      expect(JSON.stringify(await res.json())).not.toContain(apiKey);
    });

    it('maps a transport failure to 502', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

      expect((await GET(makeReq())).status).toBe(502);
    });
  });

  // ── PUT ─────────────────────────────────────────────────────────────────────────

  describe('PUT', () => {
    it.each([
      ['a malformed body', () => makeReq(undefined, { malformed: true })],
      ['a missing modelId', () => makeReq({})],
      ['a blank modelId', () => makeReq({ modelId: '   ' })],
    ])('rejects %s before reaching the vault', async (_label, req) => {
      const res = await PUT(req());

      expect(res.status).toBe(400);
      expect(mocks.setModelId).not.toHaveBeenCalled();
    });

    it(`seals the trimmed model id once ${label} confirms it`, async () => {
      const fetchMock = stubFetch({ id: modelA });

      const res = await PUT(makeReq({ modelId: `  ${modelA}  ` }));

      expect(fetchMock).toHaveBeenCalledWith(`${baseUrl}/models/${modelA}`, expect.any(Object));
      expect(mocks.setModelId).toHaveBeenCalledWith(ownerDid, modelA);
      expect(await res.json()).toEqual({ modelId: modelA });
    });

    /**
     * The point of validating before sealing: a model that no longer exists
     * must be refused on the card, not discovered at inference time as an
     * opaque failure well away from the choice that caused it.
     */
    it(`refuses a model ${label} does not serve, and seals nothing`, async () => {
      stubFetch({ error: 'not found' }, false, 404);

      const res = await PUT(makeReq({ modelId: deprecatedModelId }));

      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe('model_deprecated');
      expect(mocks.setModelId).not.toHaveBeenCalled();
    });

    it('does not misreport an unrelated upstream failure as a dead model', async () => {
      stubFetch({ error: 'rate limited' }, false, 429);

      const res = await PUT(makeReq({ modelId: modelA }));

      expect(res.status).toBe(502);
      expect(mocks.setModelId).not.toHaveBeenCalled();
    });

    it('maps a transport failure during validation to 502', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

      expect((await PUT(makeReq({ modelId: modelA }))).status).toBe(502);
      expect(mocks.setModelId).not.toHaveBeenCalled();
    });

    it('reports a sealing failure as 500 without echoing the key', async () => {
      stubFetch({ id: modelA });
      mocks.setModelId.mockRejectedValue(new Error(`vault said ${apiKey}`));

      const res = await PUT(makeReq({ modelId: modelA }));

      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).not.toContain(apiKey);
    });
  });
}
