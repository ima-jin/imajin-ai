/**
 * Tests for GET/PUT /xai/api/models (#1924).
 *
 * The vault behaviour behind `loadXaiSealedCredentials` / `xaiKeyPending` /
 * `setModelId` is covered by the token-paste factory's own tests; what is
 * pinned here is the route contract:
 *   - the sealed key rides the Authorization header and never reaches the
 *     browser, in either direction;
 *   - listing works before the owner has granted `xai:infer` (#1773);
 *   - a model xAI will not serve is refused BEFORE it is sealed, so the card
 *     cannot commit a selection that only fails later at inference time;
 *   - upstream failures surface as a status, never as an upstream body.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeModelPickerRequest,
  stubModelPickerFetch,
  resetModelPickerMocks,
} from '@/src/lib/kernel/__tests__/model-picker-route-test-support';

const { mockResolveOwnerDid, mockLoadSealed, mockKeyPending, mockSetModelId } = vi.hoisted(() => ({
  mockResolveOwnerDid: vi.fn(),
  mockLoadSealed: vi.fn(),
  mockKeyPending: vi.fn(),
  mockSetModelId: vi.fn(),
}));

vi.mock('@/src/lib/kernel/connector-owner-did', () => ({
  resolveConnectorOwnerDid: mockResolveOwnerDid,
}));

vi.mock('@/src/lib/xai/connector', () => ({
  loadXaiSealedCredentials: mockLoadSealed,
  xaiKeyPending: mockKeyPending,
  setModelId: mockSetModelId,
  XAI_BASE_URL: 'https://api.x.ai/v1',
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
const API_KEY = 'xai-SEALED-KEY';

type RouteRequest = Parameters<typeof PUT>[0];

function makeReq(body?: unknown, opts: { malformed?: boolean } = {}): RouteRequest {
  return makeModelPickerRequest(body, opts) as unknown as RouteRequest;
}

function stubFetch(body: unknown, ok = true, status = 200) {
  return stubModelPickerFetch(body, ok, status);
}

beforeEach(() => {
  resetModelPickerMocks({
    resolveOwnerDid: mockResolveOwnerDid,
    loadSealedCredentials: mockLoadSealed,
    keyPending: mockKeyPending,
    setModelId: mockSetModelId,
    ownerDid: OWNER_DID,
    apiKey: API_KEY,
  });
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('authentication', () => {
  it.each([
    ['GET', GET],
    ['PUT', PUT],
  ])('returns the auth failure from %s without touching the vault', async (_verb, handler) => {
    mockResolveOwnerDid.mockResolvedValueOnce({ ok: false, error: 'Unauthorized', status: 401 });

    const res = await handler(makeReq({ modelId: 'grok-4' }));

    expect(res.status).toBe(401);
    expect(mockLoadSealed).not.toHaveBeenCalled();
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('answers CORS pre-flight', async () => {
    expect((await OPTIONS(makeReq())).status).toBe(204);
  });
});

// ── Credential states ─────────────────────────────────────────────────────────

describe('credential states', () => {
  it('reports xai_no_key when nothing is sealed yet', async () => {
    mockLoadSealed.mockResolvedValue(undefined);

    const res = await GET(makeReq());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/xai_no_key/);
  });

  it('distinguishes a key awaiting Tier 1 approval from no key at all', async () => {
    mockLoadSealed.mockResolvedValue(undefined);
    mockKeyPending.mockResolvedValue(true);

    const res = await GET(makeReq());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/xai_credential_pending/);
  });

  it('lists models before any xai:infer grant exists (#1773)', async () => {
    stubFetch({ data: [] });

    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    // The pending probe is only consulted when nothing resolved.
    expect(mockKeyPending).not.toHaveBeenCalled();
  });
});

// ── GET ───────────────────────────────────────────────────────────────────────

describe('GET', () => {
  it('sends the key as a bearer token and never returns it', async () => {
    const fetchMock = stubFetch({ data: [{ id: 'grok-4' }, { id: 'grok-4-fast' }] });

    const res = await GET(makeReq());
    const body = await res.json() as { models: { id: string; name: string }[]; currentModelId: string | null };

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.x.ai/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${API_KEY}` }),
      }),
    );
    expect(body.models).toEqual([
      { id: 'grok-4', name: 'grok-4' },
      { id: 'grok-4-fast', name: 'grok-4-fast' },
    ]);
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it('drops malformed entries rather than offering a nameless model', async () => {
    stubFetch({ data: [{ id: 'grok-4' }, {}, { id: '' }] });

    const body = await (await GET(makeReq())).json() as { models: { id: string }[] };

    expect(body.models).toEqual([{ id: 'grok-4', name: 'grok-4' }]);
  });

  it('reports the currently sealed model alongside the list', async () => {
    mockLoadSealed.mockResolvedValue({ apiKey: API_KEY, modelId: 'grok-4' });
    stubFetch({ data: [] });

    expect((await (await GET(makeReq())).json()).currentModelId).toBe('grok-4');
  });

  it('honours a sealed baseUrl override instead of the default endpoint', async () => {
    mockLoadSealed.mockResolvedValue({ apiKey: API_KEY, baseUrl: 'https://proxy.example/v1' });
    const fetchMock = stubFetch({ data: [] });

    await GET(makeReq());

    expect(fetchMock).toHaveBeenCalledWith('https://proxy.example/v1/models', expect.any(Object));
  });

  it('maps an upstream error to 502 without forwarding its body', async () => {
    stubFetch({ error: `bad key ${API_KEY}` }, false, 401);

    const res = await GET(makeReq());

    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
  });

  it('maps a transport failure to 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    expect((await GET(makeReq())).status).toBe(502);
  });
});

// ── PUT ───────────────────────────────────────────────────────────────────────

describe('PUT', () => {
  it.each([
    ['a malformed body', () => makeReq(undefined, { malformed: true })],
    ['a missing modelId', () => makeReq({})],
    ['a blank modelId', () => makeReq({ modelId: '   ' })],
  ])('rejects %s before reaching the vault', async (_label, req) => {
    const res = await PUT(req());

    expect(res.status).toBe(400);
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('seals the trimmed model id once xAI confirms it', async () => {
    const fetchMock = stubFetch({ id: 'grok-4' });

    const res = await PUT(makeReq({ modelId: '  grok-4  ' }));

    expect(fetchMock).toHaveBeenCalledWith('https://api.x.ai/v1/models/grok-4', expect.any(Object));
    expect(mockSetModelId).toHaveBeenCalledWith(OWNER_DID, 'grok-4');
    expect(await res.json()).toEqual({ modelId: 'grok-4' });
  });

  /**
   * The point of validating before sealing: a model that no longer exists must
   * be refused on the card, not discovered at inference time as an opaque
   * failure well away from the choice that caused it.
   */
  it('refuses a model xAI does not serve, and seals nothing', async () => {
    stubFetch({ error: 'not found' }, false, 404);

    const res = await PUT(makeReq({ modelId: 'grok-1' }));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('model_deprecated');
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('does not misreport an unrelated upstream failure as a dead model', async () => {
    stubFetch({ error: 'rate limited' }, false, 429);

    const res = await PUT(makeReq({ modelId: 'grok-4' }));

    expect(res.status).toBe(502);
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('maps a transport failure during validation to 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    expect((await PUT(makeReq({ modelId: 'grok-4' }))).status).toBe(502);
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('reports a sealing failure as 500 without echoing the key', async () => {
    stubFetch({ id: 'grok-4' });
    mockSetModelId.mockRejectedValue(new Error(`vault said ${API_KEY}`));

    const res = await PUT(makeReq({ modelId: 'grok-4' }));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
  });
});
