/**
 * Tests for GET/PUT /local/api/models (#1957).
 *
 * Unlike the OpenAI-compatible providers' model pickers, `local`'s
 * `listModels`/`probeModel` go through `egressSafeFetch` (node:http/https),
 * not the global `fetch` the shared `describeModelPickerRouteContract`
 * fixture stubs — so this mocks `@/src/lib/local/model-handlers` directly
 * instead. Auth/CORS/logger mocking still reuses `mockModelPickerRouteDeps`.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  mockModelPickerRouteDeps,
  makeModelPickerRequest,
} from '@/src/lib/kernel/__tests__/model-picker-route-test-support';

const mockLoadSealed = vi.fn();
const mockSetModelId = vi.fn();
const mockListModels = vi.fn();
const mockProbeModel = vi.fn();

const { resolveOwnerDid } = mockModelPickerRouteDeps();

vi.doMock('@/src/lib/local/connector', () => ({
  loadLocalSealedCredentials: mockLoadSealed,
  setModelId: mockSetModelId,
}));

vi.doMock('@/src/lib/local/model-handlers', () => ({
  listModels: mockListModels,
  probeModel: mockProbeModel,
}));

const { GET, PUT, OPTIONS } = await import('../route');

const OWNER_DID = 'did:imajin:owner';

describe('GET/PUT /local/api/models', () => {
  beforeEach(() => {
    resolveOwnerDid.mockReset();
    resolveOwnerDid.mockResolvedValue({ ok: true, ownerDid: OWNER_DID });
    mockLoadSealed.mockReset();
    mockLoadSealed.mockResolvedValue({ apiKey: '', baseUrl: 'http://ollama.lan:11434', pinnedIp: '192.168.1.50' });
    mockSetModelId.mockReset();
    mockListModels.mockReset();
    mockProbeModel.mockReset();
  });

  it('answers CORS pre-flight', async () => {
    expect((await OPTIONS(makeModelPickerRequest())).status).toBe(204);
  });

  it('returns the auth failure without touching credentials', async () => {
    resolveOwnerDid.mockResolvedValueOnce({ ok: false, error: 'Unauthorized', status: 401 });

    const res = await GET(makeModelPickerRequest());

    expect(res.status).toBe(401);
    expect(mockLoadSealed).not.toHaveBeenCalled();
  });

  it('reports local_no_key when no baseUrl is configured yet', async () => {
    mockLoadSealed.mockResolvedValue(undefined);

    const res = await GET(makeModelPickerRequest());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/local_no_key/);
  });

  it('lists models with no bearer token required — a "no key" resolution is a success, not an error', async () => {
    mockListModels.mockResolvedValue({ ok: true, models: [{ id: 'llama3', name: 'llama3' }] });

    const res = await GET(makeModelPickerRequest());
    const body = await res.json() as { models: { id: string }[]; currentModelId: string | null };

    expect(res.status).toBe(200);
    expect(body.models).toEqual([{ id: 'llama3', name: 'llama3' }]);
    expect(mockListModels).toHaveBeenCalledWith({ apiKey: '', baseUrl: 'http://ollama.lan:11434', pinnedIp: '192.168.1.50' });
  });

  it('maps a listModels upstream failure to 502', async () => {
    mockListModels.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });

    const res = await GET(makeModelPickerRequest());

    expect(res.status).toBe(502);
  });

  it('rejects PUT with a missing modelId before probing', async () => {
    const res = await PUT(makeModelPickerRequest({}));

    expect(res.status).toBe(400);
    expect(mockProbeModel).not.toHaveBeenCalled();
    expect(mockSetModelId).not.toHaveBeenCalled();
  });

  it('seals a model once probeModel confirms it is servable', async () => {
    mockProbeModel.mockResolvedValue({ ok: true });

    const res = await PUT(makeModelPickerRequest({ modelId: 'llama3' }));

    expect(mockProbeModel).toHaveBeenCalledWith(
      { apiKey: '', baseUrl: 'http://ollama.lan:11434', pinnedIp: '192.168.1.50' },
      'llama3',
    );
    expect(mockSetModelId).toHaveBeenCalledWith(OWNER_DID, 'llama3');
    expect(await res.json()).toEqual({ modelId: 'llama3' });
  });

  it('refuses a model the endpoint does not serve (404 -> model_deprecated), sealing nothing', async () => {
    mockProbeModel.mockResolvedValue({ ok: false, deprecated: true });

    const res = await PUT(makeModelPickerRequest({ modelId: 'ghost-model' }));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('model_deprecated');
    expect(mockSetModelId).not.toHaveBeenCalled();
  });
});
