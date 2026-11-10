import { describe, expect, it, vi } from 'vitest';
import { readAlphaBody } from '../read-body';
import { ALPHA_BODY_LIMIT } from '../contract';

function chunked(chunks: Uint8Array[]) {
  const body = new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  });
  return new Request('http://localhost/api/alpha', {
    method: 'POST', headers: { 'content-length': '1' }, body, duplex: 'half',
  } as RequestInit);
}
describe('bounded alpha body reader', () => {
  it('accepts exactly the byte limit, even if the declared length is wrong', async () => {
    const json = JSON.stringify('x'.repeat(ALPHA_BODY_LIMIT - 2));
    expect(await readAlphaBody(chunked([new TextEncoder().encode(json)]))).toHaveLength(ALPHA_BODY_LIMIT - 2);
  });
  it('bounds cumulative chunks rather than trusting content-length', async () => {
    const chunk = new Uint8Array(ALPHA_BODY_LIMIT / 2);
    await expect(readAlphaBody(chunked([chunk, chunk, new Uint8Array(1)]))).rejects.toThrow('Body too large');
  });
  it('decodes multibyte characters split between chunks', async () => {
    const bytes = new TextEncoder().encode('{"text":"💡"}');
    expect(await readAlphaBody(chunked([bytes.slice(0, 11), bytes.slice(11)]))).toEqual({ text: '💡' });
  });
  it('cancels an oversized open stream and releases its reader lock', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(ALPHA_BODY_LIMIT + 1)); },
      cancel,
    });
    const request = new Request('http://localhost/api/alpha', { method: 'POST', body, duplex: 'half' } as RequestInit);
    await expect(readAlphaBody(request)).rejects.toThrow('Body too large');
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it('rejects malformed UTF-8 without returning replacement characters', async () => {
    await expect(readAlphaBody(chunked([new Uint8Array([0xff])]))).rejects.toThrow();
  });
});
