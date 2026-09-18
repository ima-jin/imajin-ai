/**
 * Tests for the OpenRouter connector's `listModels`/`probeModel` (#2188).
 *
 * Unlike every other OpenAI-compatible connector's picker
 * (`createOpenAiCompatibleModelHandlers`), `probeModel` here validates by
 * list membership rather than a per-model retrieve — see `model-handlers.ts`
 * for why OpenRouter's real single-model endpoint shape does not compose
 * with a `provider/model` id passed as one opaque string.
 *
 * Built via `createOpenrouterModelHandlers(defaultBaseUrl)` rather than
 * importing `OPENROUTER_BASE_URL` from `./connector` — that module pulls in
 * the vault/DB stack transitively, which this module (and its tests) must
 * stay free of.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOpenrouterModelHandlers } from '../model-handlers';
import type { OpenAiCompatibleCredentials } from '@/src/lib/kernel/openai-compatible-model-picker';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const { listModels, probeModel } = createOpenrouterModelHandlers(DEFAULT_BASE_URL);

const CREDS: OpenAiCompatibleCredentials = { apiKey: 'sk-or-secret' };
const CREDS_WITH_BASE_URL: OpenAiCompatibleCredentials = { apiKey: 'sk-or-secret', baseUrl: 'https://proxy.example/v1' };

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), { status, statusText, headers: { 'content-type': 'application/json' } });
}

describe('listModels', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches {baseUrl}/models with the sealed key as a bearer token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'typesafe/jev-1.13' }] }));

    const result = await listModels(CREDS);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      { headers: { Authorization: 'Bearer sk-or-secret', Accept: 'application/json' } },
    );
    expect(result).toEqual({ ok: true, models: [{ id: 'typesafe/jev-1.13', name: 'typesafe/jev-1.13' }] });
  });

  it('honours a sealed baseUrl override instead of the default endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await listModels(CREDS_WITH_BASE_URL);

    expect(fetchMock).toHaveBeenCalledWith('https://proxy.example/v1/models', expect.any(Object));
  });

  it('drops malformed entries rather than offering a nameless model', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'anthropic/claude-sonnet-4.5' }, {}, { id: '' }] }));

    const result = await listModels(CREDS);

    expect(result).toEqual({ ok: true, models: [{ id: 'anthropic/claude-sonnet-4.5', name: 'anthropic/claude-sonnet-4.5' }] });
  });

  it('maps an upstream error status without forwarding its body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401, statusText: 'Unauthorized' }));

    const result = await listModels(CREDS);

    expect(result).toEqual({ ok: false, status: 401, statusText: 'Unauthorized' });
  });
});

describe('probeModel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports ok when the model id appears in the owner\'s own model list', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'typesafe/jev-1.13' }, { id: 'anthropic/claude-sonnet-4.5' }] }));

    expect(await probeModel(CREDS, 'typesafe/jev-1.13')).toEqual({ ok: true });
  });

  it('reports deprecated: true when the model id is absent from the list, not a 404 from a single-model fetch', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'anthropic/claude-sonnet-4.5' }] }));

    expect(await probeModel(CREDS, 'openrouter/retired-model')).toEqual({ ok: false, deprecated: true });
  });

  it('never calls a per-model retrieve path \u2014 only the list endpoint, once', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'typesafe/jev-1.13' }] }));

    await probeModel(CREDS, 'typesafe/jev-1.13');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models');
  });

  it('maps a non-2xx list failure to deprecated: false with the status, not a false model_deprecated', async () => {
    fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }));

    expect(await probeModel(CREDS, 'typesafe/jev-1.13')).toEqual({ ok: false, deprecated: false, status: 429, statusText: 'Too Many Requests' });
  });
});
