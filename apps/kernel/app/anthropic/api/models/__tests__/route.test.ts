/**
 * Tests for GET/PUT /anthropic/api/models (#1953).
 *
 * `loadAnthropicSealedCredentials` / `anthropicKeyPending` / `setModelId` are
 * mocked — their vault behaviour is covered in
 * `src/lib/kernel/__tests__/connector-token-paste.test.ts` and the Anthropic
 * connector's own tests. The auth/CORS/credential-state/PUT-validation slice
 * of the route contract — everything upstream of actually calling
 * Anthropic — is shared with every other bespoke-shape model picker (Gemini)
 * via `describeModelPickerAuthAndValidationContract` in
 * `src/lib/kernel/__tests__/model-picker-route-test-support.ts` (#1953).
 * What is declared here is what makes Anthropic's OWN shape distinct: the
 * `x-api-key`/`anthropic-version` headers (not a bearer token), the
 * `has_more`/`last_id` pagination walk, and the `id`/`display_name`
 * response mapping.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  makeModelPickerRequest,
  stubModelPickerFetch,
  resetModelPickerMocks,
  mockModelPickerRouteDeps,
  describeModelPickerAuthAndValidationContract,
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

describeModelPickerAuthAndValidationContract({
  id: 'anthropic',
  GET,
  PUT,
  OPTIONS,
  makeReq,
  sampleModelId: 'claude-opus-4-6',
  apiKey: API_KEY,
  mocks: {
    resolveOwnerDid: mockResolveConnectorOwnerDid,
    loadSealedCredentials: mockLoadAnthropicSealedCredentials,
    keyPending: mockAnthropicKeyPending,
    setModelId: mockSetModelId,
  },
});

// ── Anthropic's own shape: headers, pagination, id/display_name ────────────

describe('GET', () => {
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

  it('returns 500 when sealing fails after a successful probe, without echoing the key', async () => {
    stubFetch({ id: 'claude-opus-4-6' }, true, 200);
    mockSetModelId.mockRejectedValueOnce(new Error(`vault said ${API_KEY}`));

    const res = await PUT(makeReq({ modelId: 'claude-opus-4-6' }));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
  });
});
