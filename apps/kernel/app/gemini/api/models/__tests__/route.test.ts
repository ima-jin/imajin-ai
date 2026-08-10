/**
 * Tests for GET/PUT /gemini/api/models (#1769).
 *
 * `loadGeminiCredentials` / `setModelId` are mocked — their vault behaviour is
 * covered in `src/lib/kernel/__tests__/connector-token-paste.test.ts` and the
 * Gemini connector's own tests. What this pins is the route contract: the
 * sealed API key never reaches the browser (in either direction), the model
 * list is filtered to `generateContent`-capable models with the `models/`
 * prefix stripped, and upstream/credential failures map to sane statuses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveConnectorOwnerDid, mockLoadGeminiCredentials, mockSetModelId } = vi.hoisted(() => ({
  mockResolveConnectorOwnerDid: vi.fn(),
  mockLoadGeminiCredentials: vi.fn(),
  mockSetModelId: vi.fn(),
}));

vi.mock('@/src/lib/kernel/connector-owner-did', () => ({
  resolveConnectorOwnerDid: mockResolveConnectorOwnerDid,
}));

vi.mock('@/src/lib/gemini/connector', () => ({
  loadGeminiCredentials: mockLoadGeminiCredentials,
  setModelId: mockSetModelId,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.imajin.ai' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { GET, PUT, OPTIONS } from '../route';

const OWNER_DID = 'did:imajin:farmer';
const API_KEY = 'AIzaSy-GEMINI-SEALED';

type RouteRequest = Parameters<typeof PUT>[0];

function makeReq(body?: unknown, opts: { malformed?: boolean } = {}): RouteRequest {
  return {
    headers: new Headers(),
    json: async () => {
      if (opts.malformed === true) throw new Error('invalid json');
      return body;
    },
  } as unknown as RouteRequest;
}

function stubFetch(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  mockResolveConnectorOwnerDid.mockReset();
  mockResolveConnectorOwnerDid.mockResolvedValue({ ok: true, ownerDid: OWNER_DID });
  mockLoadGeminiCredentials.mockReset();
  mockSetModelId.mockReset();
  mockSetModelId.mockResolvedValue(undefined);
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
    expect(mockLoadGeminiCredentials).not.toHaveBeenCalled();
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
    mockLoadGeminiCredentials.mockResolvedValue(undefined);

    const res = await GET(makeReq());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/gemini_no_key/);
  });

  it('filters to generateContent-capable models and strips the models/ prefix', async () => {
    mockLoadGeminiCredentials.mockResolvedValue({ apiKey: API_KEY });
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
    mockLoadGeminiCredentials.mockResolvedValue({ apiKey: API_KEY });
    stubFetch({ models: [] });

    const res = await GET(makeReq());

    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
  });

  it('sends the key to Google as a query param and never logs/echoes it on failure', async () => {
    mockLoadGeminiCredentials.mockResolvedValue({ apiKey: API_KEY });
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
    mockLoadGeminiCredentials.mockResolvedValue({ apiKey: API_KEY, modelId: 'gemini-3.6-flash' });
    stubFetch({ models: [] });

    const res = await GET(makeReq());

    expect((await res.json()).currentModelId).toBe('gemini-3.6-flash');
  });

  it('maps an upstream fetch failure to 502', async () => {
    mockLoadGeminiCredentials.mockResolvedValue({ apiKey: API_KEY });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const res = await GET(makeReq());

    expect(res.status).toBe(502);
  });

  it('carries the CORS headers', async () => {
    mockLoadGeminiCredentials.mockResolvedValue({ apiKey: API_KEY });
    stubFetch({ models: [] });

    const res = await GET(makeReq());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.imajin.ai');
  });
});

// ── PUT ───────────────────────────────────────────────────────────────────────

describe('PUT', () => {
  it('seals the chosen modelId for the acting DID', async () => {
    const res = await PUT(makeReq({ modelId: 'gemini-3.6-flash' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ modelId: 'gemini-3.6-flash' });
    expect(mockSetModelId).toHaveBeenCalledWith(OWNER_DID, 'gemini-3.6-flash');
  });

  it('trims before storing', async () => {
    await PUT(makeReq({ modelId: '  gemini-3.6-flash  ' }));

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

  it('returns 500 when sealing fails', async () => {
    mockSetModelId.mockRejectedValueOnce(new Error('vault down'));

    const res = await PUT(makeReq({ modelId: 'gemini-3.6-flash' }));

    expect(res.status).toBe(500);
  });
});
