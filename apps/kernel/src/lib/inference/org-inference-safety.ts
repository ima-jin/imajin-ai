import type { ResolvedBrain } from './brain';

/** Personal wire behavior is unchanged; org credentials cannot be echoed upstream. */
export function inferenceText(brain: ResolvedBrain, text: string): string {
  return brain.orgUsage && brain.apiKey ? text.replaceAll(brain.apiKey, '[redacted]') : text;
}

export function inferenceError(brain: ResolvedBrain, error: unknown): string {
  if (brain.orgUsage) return 'Organization inference upstream failed';
  return error instanceof Error ? error.message : String(error);
}

/** Hold only a key-length suffix, so even an echo split across SSE chunks is redacted. */
export function inferenceStream(brain: ResolvedBrain, stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  if (!brain.orgUsage || !brain.apiKey) return stream;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let end = pending.length - brain.apiKey.length + 1;
      while (end > 0) {
        const index = pending.indexOf(brain.apiKey);
        if (index >= 0) {
          controller.enqueue(encoder.encode(`${pending.slice(0, index)}[redacted]`));
          pending = pending.slice(index + brain.apiKey.length);
        } else {
          controller.enqueue(encoder.encode(pending.slice(0, end)));
          pending = pending.slice(end);
        }
        end = pending.length - brain.apiKey.length + 1;
      }
    },
    flush(controller) {
      pending += decoder.decode();
      controller.enqueue(encoder.encode(inferenceText(brain, pending)));
    },
  }));
}
