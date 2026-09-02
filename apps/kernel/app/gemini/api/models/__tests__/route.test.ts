/**
 * Tests for GET/PUT /gemini/api/models (#1769).
 *
 * `loadGeminiSealedCredentials` / `geminiKeyPending` / `setModelId` are mocked
 * — their vault behaviour is covered in
 * `src/lib/kernel/__tests__/connector-token-paste.test.ts` and the Gemini
 * connector's own tests. The auth/CORS/credential-state/PUT-validation slice
 * of the route contract — everything upstream of actually calling Google — is
 * shared with every other bespoke-shape model picker (Anthropic) via
 * `describeModelPickerAuthAndValidationContract` in
 * `src/lib/kernel/__tests__/model-picker-route-test-support.ts` (#1953).
 *
 * Gemini's model listing is NOT OpenAI-compatible, so this does not use the
 * OpenAI-compatible providers' `describeModelPickerRouteContract`. What is
 * declared here is what makes Gemini's OWN shape distinct: filtering to
 * `generateContent`-capable models, stripping the `models/` prefix, and
 * sending the key as a query param rather than a header.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  makeModelPickerRequest,
  stubModelPickerFetch,
  resetModelPickerMocks,
  mockModelPickerRouteDeps,
  describeModelPickerAuthAndValidationContract,
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

// ── Auth / CORS / credential-state / PUT-validation contract, shared with
// every other bespoke-shape model picker (Anthropic) — see
// `describeModelPickerAuthAndValidationContract` (#1953). ───────────────────

describeModelPickerAuthAndValidationContract({
  id: 'gemini',
  GET,
  PUT,
  OPTIONS,
  makeReq,
  sampleModelId: 'gemini-3.6-flash',
  apiKey: API_KEY,
  mocks: {
    resolveOwnerDid: mockResolveConnectorOwnerDid,
    loadSealedCredentials: mockLoadGeminiSealedCredentials,
    keyPending: mockGeminiKeyPending,
    setModelId: mockSetModelId,
  },
});

// ── Gemini's own shape: generateContent filtering, models/ prefix, query-param key ──

describe('GET', () => {
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

  it('sends the key as a query param on the liveness probe, and never leaks it on a non-404 failure', async () => {
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
});
