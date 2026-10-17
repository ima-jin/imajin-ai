import { describe, expect, it } from 'vitest';
import { MAX_LOOP_REQUEST_BYTES, readLoopRequest } from '../read-request';

function request(body: string, headers?: HeadersInit) {
  return new Request('https://test.imajin.ai/api/loops', { method: 'POST', body, headers });
}

describe('readLoopRequest', () => {
  it('parses JSON without requiring a content-length', async () => {
    expect(await readLoopRequest(request('{"text":"hello"}'))).toEqual({ ok: true, body: { text: 'hello' } });
  });

  it('rejects declared oversized bodies before reading them', async () => {
    expect(await readLoopRequest(request('{}', { 'content-length': String(MAX_LOOP_REQUEST_BYTES + 1) })))
      .toMatchObject({ ok: false, status: 413 });
  });

  it('counts actual UTF-8 bytes even with an understated content-length', async () => {
    expect(await readLoopRequest(request(JSON.stringify('🙂'.repeat(MAX_LOOP_REQUEST_BYTES / 4)), { 'content-length': '1' })))
      .toMatchObject({ ok: false, status: 413 });
  });

  it('accepts an exact-boundary body', async () => {
    const body = JSON.stringify('a'.repeat(MAX_LOOP_REQUEST_BYTES - 2));
    expect(await readLoopRequest(request(body))).toMatchObject({ ok: true });
  });

  it.each(['{', ''])('rejects invalid JSON: %s', async (body) => {
    expect(await readLoopRequest(request(body))).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects a missing body', async () => {
    expect(await readLoopRequest(new Request('https://test.imajin.ai/api/loops', { method: 'POST' })))
      .toMatchObject({ ok: false, status: 400 });
  });

  it('decodes multibyte characters split over chunks', async () => {
    const bytes = new TextEncoder().encode('{"text":"🙂"}');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 11));
        controller.enqueue(bytes.slice(11));
        controller.close();
      },
    });
    const req = new Request('https://test.imajin.ai/api/loops', {
      method: 'POST', body: stream, duplex: 'half',
    } as RequestInit);
    expect(await readLoopRequest(req)).toEqual({ ok: true, body: { text: '🙂' } });
  });

  it('rejects invalid UTF-8 rather than silently changing signed bytes', async () => {
    const req = new Request('https://test.imajin.ai/api/loops', { method: 'POST', body: new Uint8Array([0xff]) });
    expect(await readLoopRequest(req)).toMatchObject({ ok: false, status: 400 });
  });
});
