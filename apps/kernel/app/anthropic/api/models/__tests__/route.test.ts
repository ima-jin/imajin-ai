/**
 * Tests for GET/PUT /anthropic/api/models (#1953).
 *
 * `loadAnthropicSealedCredentials` / `anthropicKeyPending` / `setModelId` are
 * mocked — their vault behaviour is covered in
 * `src/lib/kernel/__tests__/connector-token-paste.test.ts` and the Anthropic
 * connector's own tests. What this pins is the route contract: the sealed API
 * key never reaches the browser (in either direction, and never as an
 * upstream-echoed body), listing does not require an active
 * `anthropic:infer` grant (#1773), pagination (`has_more`/`last_id`) is
 * walked to completion, and upstream/credential failures map to sane
 * statuses.
 *
 * Anthropic authenticates with `x-api-key` + `anthropic-version` headers
 * rather than a bearer token and its list/retrieve shape differs from the
 * OpenAI-compatible providers, so — like Gemini's own models route test —
 * this does NOT use `describeModelPickerRouteContract`; only the
 * connector-agnostic mock scaffolding (auth, CORS, logger) is shared, via
 * `mockModelPickerRouteDeps` in
 * `src/lib/kernel/__tests__/model-picker-route-test-support.ts`.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  makeModelPickerRequest,
  stubModelPickerFetch,
  resetModelPickerMocks,
  mockModelPickerRouteDeps,
} from '@/src/lib/kernel/__tests__/model-picker-route-test-support';

const mockLoadAnthropicSealedCredentials = vi.fn();
const mockAnthropicKeyPending = vi.fn();
const mockSetModelId = vi.fn();

const { resolveOwnerDid: mockResolveConnectorOwnerDid } = mockModelPickerRouteDeps();

vi.doMock('@/src/lib/anthropic/connector', () => ({
  loadAnthropicSealedCredentials: mockLoadAnthropicSealedCredentials,
  anthropicKeyPending: mockAnthropicKeyPending,
  setModelId: mockSetModelId,
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
}));

const { GET, PUT, OPTIONS } = await import('../route');

const OWNER_DID = 'did:imajin:farmer';
const API_KEY = 'sk-ant-SEALED';

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
    loadSealedCredentials: mockLoadAnthropicSealedCredentials,
    keyPending: mockAnthropicKeyPending,
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

    const res = await handler(makeReq({ modelId: 'claude-opus-4-6' }));

    expect(res.status).toBe(401);
    expect(mockLoadAnthropicSealedCredentials).not.toHaveBeenCalled();
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });
});

// ── GET ───────────────────────────────────────────────────────────────────────

describe('GET', () => {
  it('returns 400 when no Anthropic key is sealed for this identity', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue(undefined);

    const res = await GET(makeReq());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/anthropic_no_key/);
  });

  it('returns 409 with anthropic_credential_pending when the key is sealed but awaiting owner grant approval (#1773)', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue(undefined);
    mockAnthropicKeyPending.mockResolvedValue(true);

    const res = await GET(makeReq());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/anthropic_credential_pending/);
  });

  it('lists models from a sealed key even with no active anthropic:infer grant yet (#1773)', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    stubFetch({ data: [], has_more: false });

    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    expect(mockAnthropicKeyPending).not.toHaveBeenCalled();
  });

  it('sends the key via x-api-key/anthropic-version headers, not a bearer token', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    const fetchMock = stubFetch({ data: [], has_more: false });

    await GET(makeReq());

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
    const [, options] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(options.headers.Authorization).toBeUndefined();
  });

  it('maps id/display_name entries to { id, name } and drops malformed entries', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    stubFetch({
      data: [
        { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
        { id: 'claude-legacy-no-name' },
        {},
        { id: '' },
      ],
      has_more: false,
    });

    const body = await (await GET(makeReq())).json() as { models: { id: string; name: string }[] };

    expect(body.models).toEqual([
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-legacy-no-name', name: 'claude-legacy-no-name' },
    ]);
  });

  it('walks has_more/last_id pagination to completion', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: [{ id: 'claude-b' }], has_more: false, last_id: 'claude-b' }),
      });
    vi.stubGlobal('fetch', fetchMock);
    mockLoadAnthropicSealedCredentials.mockResolvedValue({ apiKey: API_KEY });

    const body = await (await GET(makeReq())).json() as { models: { id: string }[] };

    expect(body.models).toEqual([{ id: 'claude-a', name: 'claude-a' }, { id: 'claude-b', name: 'claude-b' }]);
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('after_id=claude-a'), expect.any(Object));
  });

  it('never returns the sealed API key to the caller', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    stubFetch({ data: [], has_more: false });

    const res = await GET(makeReq());

    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
  });

  it('reports the currently sealed modelId alongside the list', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue({ apiKey: API_KEY, modelId: 'claude-opus-4-6' });
    stubFetch({ data: [], has_more: false });

    const res = await GET(makeReq());

    expect((await res.json()).currentModelId).toBe('claude-opus-4-6');
  });

  it('honours a sealed baseUrl override instead of the default endpoint', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue({ apiKey: API_KEY, baseUrl: 'https://proxy.example/v1' });
    const fetchMock = stubFetch({ data: [], has_more: false });

    await GET(makeReq());

    expect(fetchMock).toHaveBeenCalledWith('https://proxy.example/v1/models', expect.any(Object));
  });

  it('maps an upstream error to 502 without forwarding its body', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    stubFetch({ error: { message: `bad key ${API_KEY}` } }, false, 401);

    const res = await GET(makeReq());

    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
  });

  it('maps a transport failure to 502', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const res = await GET(makeReq());

    expect(res.status).toBe(502);
  });

  it('carries the CORS headers', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    stubFetch({ data: [], has_more: false });

    const res = await GET(makeReq());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.imajin.ai');
  });
});

// ── PUT ───────────────────────────────────────────────────────────────────────

describe('PUT (validates against GET /v1/models/{model_id} before persisting)', () => {
  it('probes the model with the sealed key, then seals the chosen modelId for the acting DID', async () => {
    const fetchMock = stubFetch({ id: 'claude-opus-4-6' }, true, 200);

    const res = await PUT(makeReq({ modelId: 'claude-opus-4-6' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ modelId: 'claude-opus-4-6' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models/claude-opus-4-6',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' }),
      }),
    );
    expect(mockSetModelId).toHaveBeenCalledWith(OWNER_DID, 'claude-opus-4-6');
  });

  it('trims before probing and storing', async () => {
    const fetchMock = stubFetch({ id: 'claude-opus-4-6' }, true, 200);

    await PUT(makeReq({ modelId: '  claude-opus-4-6  ' }));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models/claude-opus-4-6',
      expect.any(Object),
    );
    expect(mockSetModelId).toHaveBeenCalledWith(OWNER_DID, 'claude-opus-4-6');
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

  it('returns 400 anthropic_no_key when no key is sealed, without probing', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await PUT(makeReq({ modelId: 'claude-opus-4-6' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/anthropic_no_key/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('returns 409 anthropic_credential_pending when the key is sealed but awaiting grant approval', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue(undefined);
    mockAnthropicKeyPending.mockResolvedValue(true);

    const res = await PUT(makeReq({ modelId: 'claude-opus-4-6' }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/anthropic_credential_pending/);
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('rejects a retired model with 422 model_deprecated when the probe 404s, without sealing it', async () => {
    stubFetch({ error: { message: 'not found' } }, false, 404);

    const res = await PUT(makeReq({ modelId: 'claude-1' }));
    const body = await res.json() as { error: string; modelId: string };

    expect(res.status).toBe(422);
    expect(body.error).toBe('model_deprecated');
    expect(body.modelId).toBe('claude-1');
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('maps a non-404 probe failure to 502 and never leaks the key', async () => {
    const fetchMock = stubFetch({ error: { message: 'rate limited' } }, false, 429);

    const res = await PUT(makeReq({ modelId: 'claude-opus-4-6' }));

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.any(Object));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('maps a network failure during the probe to 502, without sealing the model', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const res = await PUT(makeReq({ modelId: 'claude-opus-4-6' }));

    expect(res.status).toBe(502);
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('returns 500 when sealing fails after a successful probe, without echoing the key', async () => {
    stubFetch({ id: 'claude-opus-4-6' }, true, 200);
    mockSetModelId.mockRejectedValueOnce(new Error(`vault said ${API_KEY}`));

    const res = await PUT(makeReq({ modelId: 'claude-opus-4-6' }));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
  });
});
