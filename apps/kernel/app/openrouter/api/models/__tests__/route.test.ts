/**
 * Tests for GET/PUT /openrouter/api/models (#2188).
 *
 * OpenRouter does NOT use `describeModelPickerRouteContract` /
 * `describeModelPickerAuthAndValidationContract` (the shared macros every
 * other connector's model-picker route test uses,
 * `src/lib/kernel/__tests__/model-picker-route-test-support.ts`): both
 * assume a 404 from the upstream PROBE call means "this model id is
 * retired" (`model_deprecated`, 422). OpenRouter's `probeModel`
 * (`../../../../src/lib/openrouter/model-handlers.ts`) does not probe a
 * per-model endpoint at all — see that module's header for why OpenRouter's
 * real single-model shape (`GET /model/{author}/{slug}`) does not compose
 * with a `provider/model` id passed as one opaque string — so it validates
 * by LIST membership instead: a 404/failure from `GET /models` is a
 * transport fault (502), and "not found" is "absent from a successful
 * list" (422), not "the probe 404d". This file is therefore a bespoke
 * route-contract test, reusing only the connector-agnostic request/fetch
 * stubbing primitives (`makeModelPickerRequest`, `stubModelPickerFetch`,
 * `mockModelPickerRouteDeps`, `resetModelPickerMocks`).
 */
import { vi, it, expect, describe, beforeEach } from 'vitest';
import {
  mockModelPickerRouteDeps,
  makeModelPickerRequest,
  stubModelPickerFetch,
  resetModelPickerMocks,
  expectSuccessfulGetCarriesCorsHeader,
} from '@/src/lib/kernel/__tests__/model-picker-route-test-support';

const openrouterMockLoadSealed = vi.fn();
const openrouterMockKeyPending = vi.fn();
const mockSetModelId = vi.fn();

const { resolveOwnerDid: openrouterMockResolveOwnerDid, notifyModelsChanged: openrouterMockNotifyModelsChanged } = mockModelPickerRouteDeps();

vi.doMock('@/src/lib/openrouter/connector', () => ({
  loadOpenrouterSealedCredentials: openrouterMockLoadSealed,
  openrouterKeyPending: openrouterMockKeyPending,
  setModelId: mockSetModelId,
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
}));

const { GET, PUT, OPTIONS } = await import('../route');

const OWNER_DID = 'did:imajin:farmer';
const API_KEY = 'sk-or-SEALED-KEY';
const MODEL_A = 'typesafe/jev-1.13';
const MODEL_B = 'anthropic/claude-sonnet-4.5';

beforeEach(() => {
  resetModelPickerMocks({
    resolveOwnerDid: openrouterMockResolveOwnerDid,
    loadSealedCredentials: openrouterMockLoadSealed,
    keyPending: openrouterMockKeyPending,
    setModelId: mockSetModelId,
    notifyModelsChanged: openrouterMockNotifyModelsChanged,
    ownerDid: OWNER_DID,
    apiKey: API_KEY,
  });
});

// Direct, literal it() with literal expect()s on the helper's return value
// (see expectSuccessfulGetCarriesCorsHeader's doc comment) so Sonar S2699
// recognizes this file as containing real assertions.
it('answers a successful GET with the shared CORS header attached', async () => {
  const result = await expectSuccessfulGetCarriesCorsHeader({
    GET, resolveOwnerDid: openrouterMockResolveOwnerDid, loadSealedCredentials: openrouterMockLoadSealed,
    keyPending: openrouterMockKeyPending, apiKey: API_KEY,
  });
  expect(result.status).toBe(200);
  expect(result.corsOrigin).toBe('https://app.imajin.ai');
});

describe('authentication', () => {
  it.each([
    ['GET', () => GET(makeModelPickerRequest())],
    ['PUT', () => PUT(makeModelPickerRequest({ modelId: MODEL_A }))],
  ])('returns the auth failure from %s without touching the vault', async (_verb, call) => {
    openrouterMockResolveOwnerDid.mockResolvedValueOnce({ ok: false, error: 'Unauthorized', status: 401 });

    const res = await call();

    expect(res.status).toBe(401);
    expect(openrouterMockLoadSealed).not.toHaveBeenCalled();
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('answers CORS pre-flight', async () => {
    expect((await OPTIONS(makeModelPickerRequest())).status).toBe(204);
  });
});

describe('credential states', () => {
  it('reports openrouter_no_key when nothing is sealed yet', async () => {
    openrouterMockLoadSealed.mockResolvedValue(undefined);

    const res = await GET(makeModelPickerRequest());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/openrouter_no_key/);
  });

  it('distinguishes a key awaiting Tier 1 approval from no key at all', async () => {
    openrouterMockLoadSealed.mockResolvedValue(undefined);
    openrouterMockKeyPending.mockResolvedValue(true);

    const res = await GET(makeModelPickerRequest());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/openrouter_credential_pending/);
  });

  it('lists models before any openrouter:infer grant exists (#1773)', async () => {
    stubModelPickerFetch({ data: [] });

    const res = await GET(makeModelPickerRequest());

    expect(res.status).toBe(200);
    expect(openrouterMockKeyPending).not.toHaveBeenCalled();
  });
});

describe('GET', () => {
  it('sends the key as a bearer token and never returns it', async () => {
    const fetchMock = stubModelPickerFetch({ data: [{ id: MODEL_A }, { id: MODEL_B }] });

    const res = await GET(makeModelPickerRequest());
    const body = await res.json() as { models: { id: string; name: string }[]; currentModelId: string | null };

    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      { headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' } },
    );
    expect(body.models).toEqual([
      { id: MODEL_A, name: MODEL_A },
      { id: MODEL_B, name: MODEL_B },
    ]);
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it('reports the currently sealed model alongside the list', async () => {
    openrouterMockLoadSealed.mockResolvedValue({ apiKey: API_KEY, modelId: MODEL_A });
    stubModelPickerFetch({ data: [] });

    expect((await (await GET(makeModelPickerRequest())).json()).currentModelId).toBe(MODEL_A);
  });

  it('maps an upstream error to 502 without forwarding its body', async () => {
    stubModelPickerFetch({ error: `bad key ${API_KEY}` }, false, 401);

    const res = await GET(makeModelPickerRequest());

    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
  });

  it('maps a transport failure to 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    expect((await GET(makeModelPickerRequest())).status).toBe(502);
  });
});

describe('PUT', () => {
  it.each([
    ['a malformed body', () => makeModelPickerRequest(undefined, { malformed: true })],
    ['a missing modelId', () => makeModelPickerRequest({})],
    ['a blank modelId', () => makeModelPickerRequest({ modelId: '   ' })],
  ])('rejects %s before reaching the vault', async (_label, req) => {
    const res = await PUT(req());

    expect(res.status).toBe(400);
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('returns 400 openrouter_no_key when no key is sealed, without probing', async () => {
    openrouterMockLoadSealed.mockResolvedValue(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await PUT(makeModelPickerRequest({ modelId: MODEL_A }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/openrouter_no_key/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('returns 409 openrouter_credential_pending when the key is sealed but awaiting grant approval', async () => {
    openrouterMockLoadSealed.mockResolvedValue(undefined);
    openrouterMockKeyPending.mockResolvedValue(true);

    const res = await PUT(makeModelPickerRequest({ modelId: MODEL_A }));

    expect(res.status).toBe(409);
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('seals the trimmed `provider/model` id (with a slash) once it appears in the owner\'s own model list', async () => {
    stubModelPickerFetch({ data: [{ id: MODEL_A }] });

    const res = await PUT(makeModelPickerRequest({ modelId: `  ${MODEL_A}  ` }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ modelId: MODEL_A });
    expect(mockSetModelId).toHaveBeenCalledWith(OWNER_DID, MODEL_A);
    // #2220 — explicit catalog-refresh trigger, advisory catalog-update hint.
    expect(openrouterMockNotifyModelsChanged).toHaveBeenCalledTimes(1);
    expect(openrouterMockNotifyModelsChanged).toHaveBeenCalledWith(OWNER_DID, 'openrouter', 'catalog-update');
  });

  /**
   * The point of validating before sealing: a model absent from the owner's
   * own list must be refused on the card, not discovered at inference time
   * as an opaque failure well away from the choice that caused it.
   */
  it('refuses a model id absent from the list with 422 model_deprecated, and seals nothing', async () => {
    stubModelPickerFetch({ data: [{ id: MODEL_B }] });

    const res = await PUT(makeModelPickerRequest({ modelId: 'openrouter/retired-model' }));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('model_deprecated');
    expect(mockSetModelId).not.toHaveBeenCalled();
    expect(openrouterMockNotifyModelsChanged).not.toHaveBeenCalled();
  });

  it('maps a failed list fetch to 502 \u2014 never misreports a transport fault as model_deprecated', async () => {
    stubModelPickerFetch({ error: 'rate limited' }, false, 429);

    const res = await PUT(makeModelPickerRequest({ modelId: MODEL_A }));

    expect(res.status).toBe(502);
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('maps a transport failure during validation to 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    expect((await PUT(makeModelPickerRequest({ modelId: MODEL_A }))).status).toBe(502);
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('reports a sealing failure as 500 without echoing the key', async () => {
    stubModelPickerFetch({ data: [{ id: MODEL_A }] });
    mockSetModelId.mockRejectedValue(new Error(`vault said ${API_KEY}`));

    const res = await PUT(makeModelPickerRequest({ modelId: MODEL_A }));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
    expect(openrouterMockNotifyModelsChanged).not.toHaveBeenCalled();
  });
});
