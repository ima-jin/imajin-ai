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
import { randomBytes } from 'node:crypto';
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

const { resolveOwnerDid: mockResolveConnectorOwnerDid, notifyModelsChanged: mockNotifyModelsChanged } = mockModelPickerRouteDeps();
const modelLog = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
vi.doMock('@imajin/logger', () => ({ createLogger: () => modelLog }));

vi.doMock('@/src/lib/anthropic/connector', () => ({
  loadAnthropicSealedCredentials: mockLoadAnthropicSealedCredentials,
  anthropicKeyPending: mockAnthropicKeyPending,
  setModelId: mockSetModelId,
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
}));

const { GET, PUT, OPTIONS } = await import('../route');

const OWNER_DID = 'did:imajin:farmer';
const API_KEY = randomBytes(32).toString('hex');
const INVALID_KEY_MESSAGE = 'Anthropic rejected this key (invalid or wrong key type) — re-seal a Console API key';

type RouteRequest = Parameters<typeof PUT>[0];

function makeReq(body?: unknown, opts: { malformed?: boolean } = {}): RouteRequest {
  return makeModelPickerRequest(body, opts) as unknown as RouteRequest;
}

function stubFetch(body: unknown, ok = true, status = 200) {
  return stubModelPickerFetch(body, ok, status);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetModelPickerMocks({
    resolveOwnerDid: mockResolveConnectorOwnerDid,
    loadSealedCredentials: mockLoadAnthropicSealedCredentials,
    keyPending: mockAnthropicKeyPending,
    setModelId: mockSetModelId,
    notifyModelsChanged: mockNotifyModelsChanged,
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
    notifyModelsChanged: mockNotifyModelsChanged,
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

  it('sends the exact header set Anthropic requires \u2014 x-api-key, anthropic-version, and content-type (#2196)', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    const fetchMock = stubFetch({ data: [], has_more: false });

    await GET(makeReq());

    const [url, options] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect(options.headers).toEqual({
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
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

  it('classifies rejected credentials without forwarding an unrecognised body shape', async () => {
    // Not Anthropic's real `{ error: { type, message } }` envelope (#2196) —
    // only that shape's `type`/`message` strings are ever read, so a body
    // that doesn't match it must still fall back to the plain status text.
    mockLoadAnthropicSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    stubFetch({ details: `bad key ${API_KEY}` }, false, 401);

    const res = await GET(makeReq());
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
  });

  it.each([400, 401, 403])('returns actionable invalid-key text and logs safe diagnostics for upstream %s', async status => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    stubFetch(
      { type: 'error', error: { type: 'invalid_request_error', message: 'after_id is not a valid model ID' } },
      false,
      status,
    );

    const res = await GET(makeReq());
    const body = await res.json() as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe(`anthropic_invalid_key: ${INVALID_KEY_MESSAGE}`);
    expect(modelLog.warn).toHaveBeenCalledWith({
      ownerDid: OWNER_DID, status, type: 'invalid_request_error', message: 'after_id is not a valid model ID',
    }, 'anthropic models: upstream list failed');
    expect(JSON.stringify(modelLog.warn.mock.calls)).not.toContain(API_KEY);
    expect(body.error).not.toContain(API_KEY);
  });

  it('classifies credential rejection even when the upstream body is not JSON', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => { throw new Error('not json'); },
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(makeReq());
    const body = await res.json() as { error: string };
    expect(res.status).toBe(400);
    expect(body.error).toBe(`anthropic_invalid_key: ${INVALID_KEY_MESSAGE}`);
  });

  it('maps a transport failure to 502', async () => {
    mockLoadAnthropicSealedCredentials.mockResolvedValue({ apiKey: API_KEY });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const res = await GET(makeReq());

    expect(res.status).toBe(502);
  });

  it.each(['full', 'prefix', 'suffix', 'middle'] as const)('never logs echoed %s key material or headers', async part => {
    const fragments = { full: API_KEY, prefix: API_KEY.slice(0, 12), suffix: API_KEY.slice(-12), middle: API_KEY.slice(12, 24) };
    const echoed = fragments[part];
    stubFetch({
      error: { type: `invalid_request_error ${echoed}`, message: `Rejected ${echoed}` },
      headers: { 'x-api-key': API_KEY },
    }, false, 401);

    const res = await GET(makeReq());
    const body = await res.json();
    const serialized = JSON.stringify([modelLog.warn.mock.calls, modelLog.error.mock.calls, body]);
    expect(res.status).toBe(400);
    expect(body.code).toBe('anthropic_invalid_key');
    expect(body.message).toBe(INVALID_KEY_MESSAGE);
    expect(modelLog.warn.mock.calls[0][0]).toMatchObject({ status: 401, type: '[redacted]', message: '[redacted]' });
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(echoed);
    expect(serialized).not.toContain('x-api-key');
  });

  it.each([500, 503, 529])('keeps upstream %s as an outage, not an invalid key', async status => {
    stubFetch({ error: { type: 'api_error', message: 'Service unavailable' } }, false, status);
    const res = await GET(makeReq());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(`anthropic_models: upstream ${status} Error`);
    expect(modelLog.warn).toHaveBeenCalledWith(expect.objectContaining({ status, type: 'api_error', message: 'Service unavailable' }), expect.any(String));
  });

  it('keeps a timeout as an outage and never logs an exception echoing credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException(`Timed out ${API_KEY}`, 'TimeoutError')));
    const res = await GET(makeReq());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('anthropic_models: failed to reach Anthropic');
    expect(modelLog.error).toHaveBeenCalledWith({ ownerDid: OWNER_DID }, 'anthropic models: fetch failed');
    expect(JSON.stringify(modelLog.error.mock.calls)).not.toContain(API_KEY);
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
    // #2220 — explicit catalog-refresh trigger, advisory catalog-update hint.
    expect(mockNotifyModelsChanged).toHaveBeenCalledTimes(1);
    expect(mockNotifyModelsChanged).toHaveBeenCalledWith(OWNER_DID, 'anthropic', 'catalog-update');
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

  it('surfaces the upstream error.type/error.message on a non-404 probe failure (#2196)', async () => {
    stubFetch(
      { type: 'error', error: { type: 'permission_error', message: 'This API key does not have permission' } },
      false,
      403,
    );

    const res = await PUT(makeReq({ modelId: 'claude-opus-4-6' }));
    const body = await res.json() as { error: string };

    expect(res.status).toBe(502);
    expect(body.error).toBe('anthropic_models: upstream 403 permission_error: This API key does not have permission');
    expect(mockSetModelId).not.toHaveBeenCalled();
  });
});
