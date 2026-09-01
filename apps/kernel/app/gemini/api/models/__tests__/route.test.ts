/**
 * Tests for GET/PUT /gemini/api/models (#1769).
 *
 * `loadGeminiSealedCredentials` / `geminiKeyPending` / `setModelId` are mocked
 * — their vault behaviour is covered in
 * `src/lib/kernel/__tests__/connector-token-paste.test.ts` and the Gemini
 * connector's own tests. What this pins is the route contract: the sealed API
 * key never reaches the browser (in either direction), the model list is
 * filtered to `generateContent`-capable models with the `models/` prefix
 * stripped, listing does not require an active `gemini:infer` grant (#1773),
 * and upstream/credential failures map to sane statuses.
 *
 * Gemini's model listing is NOT OpenAI-compatible, so this does not use
 * `describeModelPickerRouteContract` — only the connector-agnostic mock
 * scaffolding (auth, CORS, logger) is shared, via `mockModelPickerRouteDeps`
 * in `src/lib/kernel/__tests__/model-picker-route-test-support.ts`.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  makeModelPickerRequest,
  stubModelPickerFetch,
  resetModelPickerMocks,
  mockModelPickerRouteDeps,
} from '@/src/lib/kernel/__tests__/model-picker-route-test-support';

const mockLoadGeminiSealedCredentials = vi.fn();
const mockGeminiKeyPending = vi.fn();
const mockSetModelId = vi.fn();

const { resolveOwnerDid: mockResolveConnectorOwnerDid } = mockModelPickerRouteDeps();

vi.doMock('@/src/lib/gemini/connector', () => ({
  loadGeminiSealedCredentials: mockLoadGeminiSealedCredentials,
  geminiKeyPending: mockGeminiKeyPending,
  setModelId: mockSetModelId,
}));

const { GET, PUT, OPTIONS } = await import('../route');

const OWNER_DID = 'did:imajin:farmer';
const API_KEY = 'AIzaSy-GEMINI-SEALED';

type RouteRequest = Parameters<typeof PUT>[0];

function makeReq(body?: unknown, opts: { malformed?: boolean } = {}): RouteRequest {
  return makeModelPickerRequest(body, opts) as unknown as RouteRequest;
}

function stubFetch(body: unknown, ok = true, status = 200) {
  return stubModelPickerFetch(body, ok, status);
}

beforeEach(() => {
  resetModelPickerMocks({
    resolveOwnerDid: mockResolveConnectorOwnerDid,
    loadSealedCredentials: mockLoadGeminiSealedCredentials,
    keyPending: mockGeminiKeyPending,
    setModelId: mockSetModelId,
    ownerDid: OWNER_DID,
    apiKey: API_KEY,
  });
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('every verb is authenticated', () => {
  it.each([
    ['GET', GET],
    ['PUT', PUT],
  ])('returns the auth failure from %s without touching credentials', async (_verb, handler) => {
    mockResolveConnectorOwnerDid.mockResolvedValueOnce({ ok: false, error: 'Unauthorized', status: 401 });

    const res = await handler(makeReq({ modelId: 'gemini-3.6-flash' }));

    expect(res.status).toBe(401);
    expect(mockLoadGeminiSealedCredentials).not.toHaveBeenCalled();
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });
});

// ── GET ───────────────────────────────────────────────────────────────────────

describe('GET', () => {
  it('returns 400 when no Gemini key is sealed for this identity', async () => {
    mockLoadGeminiSealedCredentials.mockResolvedValue(undefined);

    const res = await GET(makeReq());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/gemini_no_key/);
  });

  it('returns 409 with gemini_credential_pending when the key is sealed but awaiting owner grant approval (#1773)', async () => {
    mockLoadGeminiSealedCredentials.mockResolvedValue(undefined);
    mockGeminiKeyPending.mockResolvedValue(true);

    const res = await GET(makeReq());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/gemini_credential_pending/);
  });

  it('lists models from a sealed key even with no active gemini:infer grant yet (#1773)', async () => {
    mockLoadGeminiSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    stubFetch({ models: [] });

    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    expect(mockGeminiKeyPending).not.toHaveBeenCalled();
  });

  it('filters to generateContent-capable models and strips the models/ prefix', async () => {
    mockLoadGeminiSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    stubFetch({
      models: [
        {
          name: 'models/gemini-3.6-flash',
          displayName: 'Gemini 3.6 Flash',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/embedding-004',
          displayName: 'Embedding 004',
          supportedGenerationMethods: ['embedContent'],
        },
        {
          name: 'models/gemini-legacy-vision',
          displayName: 'Gemini Legacy Vision',
          // No supportedGenerationMethods at all — must not throw.
        },
      ],
    });

    const res = await GET(makeReq());
    const body = await res.json() as { models: { id: string; name: string }[]; currentModelId: string | null };

    expect(body.models).toEqual([{ id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' }]);
  });

  it('never returns the sealed API key to the caller', async () => {
    mockLoadGeminiSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    stubFetch({ models: [] });

    const res = await GET(makeReq());

    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
  });

  it('sends the key to Google as a query param and never logs/echoes it on failure', async () => {
    mockLoadGeminiSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    const fetchMock = stubFetch({ error: { message: 'API key not valid' } }, false, 400);

    const res = await GET(makeReq());

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(API_KEY)),
      expect.any(Object),
    );
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
  });

  it('reports the currently sealed modelId alongside the list', async () => {
    mockLoadGeminiSealedCredentials.mockResolvedValue({ apiKey: API_KEY, modelId: 'gemini-3.6-flash' });
    stubFetch({ models: [] });

    const res = await GET(makeReq());

    expect((await res.json()).currentModelId).toBe('gemini-3.6-flash');
  });

  it('maps an upstream fetch failure to 502', async () => {
    mockLoadGeminiSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const res = await GET(makeReq());

    expect(res.status).toBe(502);
  });

  it('carries the CORS headers', async () => {
    mockLoadGeminiSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    stubFetch({ models: [] });

    const res = await GET(makeReq());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.imajin.ai');
  });
});

// ── PUT ───────────────────────────────────────────────────────────────────────

describe('PUT (#1818: validates liveness before persisting)', () => {
  it('probes the model with the sealed key, then seals the chosen modelId for the acting DID', async () => {
    const fetchMock = stubFetch({}, true, 200);

    const res = await PUT(makeReq({ modelId: 'gemini-3.6-flash' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ modelId: 'gemini-3.6-flash' });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('gemini-3.6-flash:generateContent'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mockSetModelId).toHaveBeenCalledWith(OWNER_DID, 'gemini-3.6-flash');
  });

  it('trims before probing and storing', async () => {
    const fetchMock = stubFetch({}, true, 200);

    await PUT(makeReq({ modelId: '  gemini-3.6-flash  ' }));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('gemini-3.6-flash:generateContent'),
      expect.any(Object),
    );
    expect(mockSetModelId).toHaveBeenCalledWith(OWNER_DID, 'gemini-3.6-flash');
  });

  it('returns 400 on malformed JSON', async () => {
    const res = await PUT(makeReq(undefined, { malformed: true }));

    expect(res.status).toBe(400);
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['blank', { modelId: '   ' }],
    ['non-string', { modelId: 42 }],
  ])('returns 400 when modelId is %s', async (_label, body) => {
    const res = await PUT(makeReq(body));

    expect(res.status).toBe(400);
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('returns 400 gemini_no_key when no key is sealed, without probing', async () => {
    mockLoadGeminiSealedCredentials.mockResolvedValue(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await PUT(makeReq({ modelId: 'gemini-3.6-flash' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/gemini_no_key/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('returns 409 gemini_credential_pending when the key is sealed but awaiting grant approval', async () => {
    mockLoadGeminiSealedCredentials.mockResolvedValue(undefined);
    mockGeminiKeyPending.mockResolvedValue(true);

    const res = await PUT(makeReq({ modelId: 'gemini-3.6-flash' }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/gemini_credential_pending/);
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('rejects a retired model with 422 model_deprecated when the probe 404s, without sealing it', async () => {
    stubFetch({ error: { message: 'model not found' } }, false, 404);

    const res = await PUT(makeReq({ modelId: 'gemini-2.0-flash' }));
    const body = await res.json() as { error: string; modelId: string };

    expect(res.status).toBe(422);
    expect(body.error).toBe('model_deprecated');
    expect(body.modelId).toBe('gemini-2.0-flash');
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('maps a non-404 probe failure to 502 and never leaks the key', async () => {
    const fetchMock = stubFetch({ error: { message: 'API key not valid' } }, false, 400);

    const res = await PUT(makeReq({ modelId: 'gemini-3.6-flash' }));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(API_KEY)),
      expect.any(Object),
    );
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('maps a network failure during the probe to 502, without sealing the model', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const res = await PUT(makeReq({ modelId: 'gemini-3.6-flash' }));

    expect(res.status).toBe(502);
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('returns 500 when sealing fails after a successful probe', async () => {
    stubFetch({}, true, 200);
    mockSetModelId.mockRejectedValueOnce(new Error('vault down'));

    const res = await PUT(makeReq({ modelId: 'gemini-3.6-flash' }));

    expect(res.status).toBe(500);
  });
});
