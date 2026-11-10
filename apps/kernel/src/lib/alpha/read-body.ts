import { ALPHA_BODY_LIMIT } from './contract';

/** Bound actual bytes, including chunked bodies or a dishonest Content-Length. */
export async function readAlphaBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Invalid body');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ALPHA_BODY_LIMIT) break;
      text += decoder.decode(value, { stream: true });
    }
    if (size > ALPHA_BODY_LIMIT) {
      await reader.cancel();
      throw new Error('Body too large');
    }
    text += decoder.decode();
    if (request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(text));
    }
    return JSON.parse(text) as unknown;
  } finally {
    reader.releaseLock();
  }
}
