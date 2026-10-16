/** Hard ingress bound, including chunked bodies; inline output has a smaller storage cap. */
export const MAX_LOOP_REQUEST_BYTES = 1024 * 1024;

type BodyResult =
  | { ok: true; body: unknown }
  | { ok: false; error: string; status: number };

export async function readLoopRequest(request: Request): Promise<BodyResult> {
  const tooLarge = { ok: false, error: 'Loop request exceeds 1048576 bytes', status: 413 } as const;
  const declaredLength = Number(request.headers.get('content-length'));
  if (declaredLength > MAX_LOOP_REQUEST_BYTES) return tooLarge;

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, error: 'Invalid JSON', status: 400 };

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_LOOP_REQUEST_BYTES) {
        await reader.cancel();
        return tooLarge;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: 'Invalid JSON', status: 400 };
  } finally {
    reader.releaseLock();
  }
}
