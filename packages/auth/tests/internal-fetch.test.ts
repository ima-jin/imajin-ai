import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internalFetch, InternalFetchError, INTERNAL_FETCH_TIMEOUT_MS } from '../src/internal-fetch.cjs';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('internalFetch total deadline', () => {
  it('aborts headers and settles even a fetch implementation that ignores the signal', async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetch);
    const pending = internalFetch('http://localhost/auth/api/session');
    const checked = expect(pending).rejects.toMatchObject({
      name: 'InternalFetchError', code: 'INTERNAL_FETCH_TIMEOUT',
      targetPath: '/auth/api/session', durationMs: INTERNAL_FETCH_TIMEOUT_MS,
    });
    await vi.advanceTimersByTimeAsync(INTERNAL_FETCH_TIMEOUT_MS);
    await checked;
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not expose upstream text in JSON parse errors that callers log', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('SECRET_ECHOED_TOKEN not-json')));
    const response = await internalFetch('http://localhost/auth/api/session?secret=omitted');
    const failure = await response.json().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InternalFetchError);
    expect(failure).toMatchObject({ targetPath: '/auth/api/session', code: 'INTERNAL_RESPONSE_INVALID' });
    expect(String(failure)).not.toContain('SECRET');
    expect(String(failure)).not.toContain('omitted');
  });

  it('bounds the body too, not just the time to headers', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, init) => {
      signal = init.signal;
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"pending":')); },
      })));
    }));
    const checked = expect(internalFetch('http://localhost/auth/api/session'))
      .rejects.toBeInstanceOf(InternalFetchError);
    await vi.advanceTimersByTimeAsync(INTERNAL_FETCH_TIMEOUT_MS);
    await checked;
    expect(signal?.aborted).toBe(true);
  });

  it.each([200, 401, 503])('preserves status %i and the complete response body', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ value: 'ok' }, { status })));
    const response = await internalFetch('http://localhost/auth/api/session');
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ value: 'ok' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves an empty 204 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    expect((await internalFetch('http://localhost/profile/api/presence/update')).status).toBe(204);
  });

  it('logs nested cause code, path and duration without secrets or the raw error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed SECRET_RAW_ERROR', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    }));
    await expect(internalFetch('http://localhost/auth/api/session?token=SECRET_QUERY', {
      headers: { cookie: 'SECRET_COOKIE', authorization: 'Bearer SECRET_BEARER', 'x-internal-api-key': 'SECRET_KEY' },
    })).rejects.toMatchObject({ code: 'UND_ERR_CONNECT_TIMEOUT' });
    const output = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(output).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(output).toContain('/auth/api/session');
    expect(output).toContain('durationMs');
    expect(output).not.toContain('SECRET');
  });

  it.each(['secret token value', 'SECRET_MATERIAL'])('does not log arbitrary error code %s', async (code) => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw { code }; }));
    await expect(internalFetch('http://localhost/api/session')).rejects.toMatchObject({
      code: 'INTERNAL_FETCH_FAILED',
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(code);
  });

  it.each([0, -1, Number.NaN, 1.5, 100_000])('rejects invalid timeout %s before fetching', async (timeout) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(internalFetch('http://localhost/api/session', {}, timeout)).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([true, false])('preserves caller cancellation (already aborted: %s)', async (aborted) => {
    const controller = new AbortController();
    if (aborted) controller.abort();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const checked = expect(internalFetch('http://localhost/api/session', { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'INTERNAL_FETCH_ABORTED' });
    controller.abort();
    await checked;
    expect(vi.getTimerCount()).toBe(0);
  });
});
