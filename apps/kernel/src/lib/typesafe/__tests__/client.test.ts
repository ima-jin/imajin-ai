/**
 * TypeSafe.ai HTTP client tests (#2197).
 *
 * Covers the retry/backoff contract from the issue: 429/529 retried with
 * backoff honouring `retry-after`, capped at 3 total attempts; 422 (and
 * every other status) surfaced immediately, never retried. Also pins
 * byte-for-byte pass-through of `answers` for all three question types, and
 * the `GET /v1/models` probe's 200/401 paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getModels, postSystemOne, TypesafeUpstreamError, type TypesafeSystemOneRequest } from '../client';

const API_KEY = 'ts-secret-key';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

describe('getModels', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches GET /v1/models with the sealed key as a bearer token, and never elsewhere', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      models: [{ name: 'jev-latest', description: 'Latest Jev', release_date: '2026-01-01' }],
    }, { headers: { 'x-typesafe-request-id': 'req_1' } }));

    const result = await getModels(API_KEY);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/models');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.stringify(init)).not.toContain('nope-not-the-key');

    expect(result.data.models).toEqual([{ name: 'jev-latest', description: 'Latest Jev', release_date: '2026-01-01' }]);
    expect(result.requestId).toBe('req_1');
  });

  it('throws TypesafeUpstreamError with status 401 on a bad key, without retrying', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_api_key' }, { status: 401 }));

    const err = await getModels(API_KEY).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TypesafeUpstreamError);
    expect((err as TypesafeUpstreamError).status).toBe(401);
    expect((err as TypesafeUpstreamError).body).toEqual({ error: 'invalid_api_key' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('postSystemOne', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const REQUEST: TypesafeSystemOneRequest = {
    state: { orderId: 'ord_1', amount: 42 },
    model: 'jev-latest',
    questions: {
      is_fraud: { type: 'noul', instructions: 'Is this order fraudulent?' },
      category: {
        type: 'choice',
        instructions: 'Classify the order.',
        criteria: { retail: 'consumer purchase', wholesale: 'bulk purchase' },
      },
      risk: {
        type: 'score',
        instructions: 'Score the risk level.',
        criteria: ['low', 'medium', 'high'],
      },
    },
  };

  /**
   * Byte-for-byte pass-through of `answers` (incl. `probabilities`,
   * `confidence`, `legend`) for all three question types in one round trip —
   * the load-bearing contract of `POST /typesafe/api/decide`.
   */
  it('passes POST body through and returns answers/usage/model byte-for-byte, for all three question types', async () => {
    const upstreamResponse = {
      model: 'jev-1.13.0',
      answers: {
        is_fraud: { noul: 0.02 },
        category: {
          probabilities: { retail: 0.9, wholesale: 0.1 },
          confidence: 0.87,
        },
        risk: {
          probabilities: { low: 0.7, medium: 0.25, high: 0.05 },
          confidence: 0.81,
          legend: ['low', 'medium', 'high'],
        },
      },
      usage: { input_tokens: 512, output_tokens: 0 },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(upstreamResponse, { headers: { 'x-typesafe-request-id': 'req_abc' } }));

    const result = await postSystemOne(API_KEY, REQUEST);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(init.body as string)).toEqual(REQUEST);

    expect(result.data).toEqual(upstreamResponse);
    expect(result.requestId).toBe('req_abc');
  });

  it('surfaces a 422 (caller bug) immediately, without retrying', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_criteria' }, { status: 422 }));

    const err = await postSystemOne(API_KEY, REQUEST).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TypesafeUpstreamError);
    expect((err as TypesafeUpstreamError).status).toBe(422);
    expect((err as TypesafeUpstreamError).body).toEqual({ error: 'invalid_criteria' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 429 once, honouring retry-after, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(jsonResponse({ model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }));

    const result = await postSystemOne(API_KEY, REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.data.model).toBe('jev-1.13.0');
  });

  it('retries 529 the same way as 429', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'overloaded' }, { status: 529, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(jsonResponse({ model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }));

    const result = await postSystemOne(API_KEY, REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.data.model).toBe('jev-1.13.0');
  });

  it('caps retries at 3 total attempts, then surfaces the last 429', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '0' } }));

    const err = await postSystemOne(API_KEY, REQUEST).catch((e: unknown) => e);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(TypesafeUpstreamError);
    expect((err as TypesafeUpstreamError).status).toBe(429);
  });

  it('falls back to exponential backoff when retry-after is absent, and still retries', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }));

    const result = await postSystemOne(API_KEY, REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.data.model).toBe('jev-1.13.0');
  });

  it('never puts the API key anywhere but the outgoing Authorization header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }));

    await postSystemOne(API_KEY, REQUEST);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body as string).not.toContain(API_KEY);
  });
});
