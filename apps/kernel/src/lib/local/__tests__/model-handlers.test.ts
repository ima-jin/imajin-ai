/**
 * Tests for the local connector's `listModels`/`probeModel` (#1957).
 *
 * These route every call through `egressSafeFetch` rather than the bare
 * `fetch()` `createOpenAiCompatibleModelHandlers` uses, so `egressSafeFetch`
 * is mocked directly here rather than stubbing global `fetch`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const egressSafeFetchMock = vi.fn();
vi.mock('@/src/lib/kernel/egress-fetch', () => ({
  egressSafeFetch: (...args: unknown[]) => egressSafeFetchMock(...args),
}));

import { listModels, probeModel } from '../model-handlers';
import type { LocalCredentials } from '../connector';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const CREDS: LocalCredentials = { apiKey: 'secret-token', baseUrl: 'http://ollama.lan:11434/', pinnedIp: '192.168.1.50' };
const CREDS_NO_TOKEN: LocalCredentials = { apiKey: '', baseUrl: 'http://ollama.lan:11434', pinnedIp: '192.168.1.50' };

describe('listModels', () => {
  beforeEach(() => {
    egressSafeFetchMock.mockReset();
  });

  it('fetches {baseUrl}/v1/models with the Authorization header and the pinned IP, trimming a trailing slash', async () => {
    egressSafeFetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'llama3' }] }));

    const result = await listModels(CREDS);

    expect(egressSafeFetchMock).toHaveBeenCalledWith(
      'http://ollama.lan:11434/v1/models',
      { method: 'GET', headers: { Authorization: 'Bearer secret-token', Accept: 'application/json' } },
      { connector: 'local', timeoutMs: expect.any(Number), pinnedIp: '192.168.1.50' },
    );
    expect(result).toEqual({ ok: true, models: [{ id: 'llama3', name: 'llama3' }] });
  });

  it('omits the Authorization header entirely when no bearer token is sealed', async () => {
    egressSafeFetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await listModels(CREDS_NO_TOKEN);

    const [, init] = egressSafeFetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('drops malformed entries rather than offering a nameless model', async () => {
    egressSafeFetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'llama3' }, {}, { id: '' }] }));

    const result = await listModels(CREDS);

    expect(result).toEqual({ ok: true, models: [{ id: 'llama3', name: 'llama3' }] });
  });

  it('maps an upstream error status without forwarding its body', async () => {
    egressSafeFetchMock.mockResolvedValueOnce(new Response('nope', { status: 500, statusText: 'Internal Server Error' }));

    const result = await listModels(CREDS);

    expect(result).toEqual({ ok: false, status: 500, statusText: 'Internal Server Error' });
  });
});

describe('probeModel', () => {
  beforeEach(() => {
    egressSafeFetchMock.mockReset();
  });

  it('retrieves {baseUrl}/v1/models/{modelId}, URL-encoded', async () => {
    egressSafeFetchMock.mockResolvedValueOnce(jsonResponse({ id: 'llama3:latest' }));

    await probeModel(CREDS, 'llama3:latest');

    const [url] = egressSafeFetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://ollama.lan:11434/v1/models/llama3%3Alatest');
  });

  it('reports ok when the endpoint serves the model', async () => {
    egressSafeFetchMock.mockResolvedValueOnce(jsonResponse({ id: 'llama3' }));
    expect(await probeModel(CREDS, 'llama3')).toEqual({ ok: true });
  });

  it('maps a 404 to deprecated: true', async () => {
    egressSafeFetchMock.mockResolvedValueOnce(new Response('not found', { status: 404, statusText: 'Not Found' }));
    expect(await probeModel(CREDS, 'ghost-model')).toEqual({ ok: false, deprecated: true });
  });

  it('maps a non-404 failure to deprecated: false with the status', async () => {
    egressSafeFetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }));
    expect(await probeModel(CREDS, 'llama3')).toEqual({ ok: false, deprecated: false, status: 429, statusText: 'Too Many Requests' });
  });
});
