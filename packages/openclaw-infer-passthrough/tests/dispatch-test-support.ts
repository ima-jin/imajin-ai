/**
 * Shared test helpers for `handle-completions.test.ts` (OpenAI-compatible)
 * and `anthropic-handler.test.ts` (Anthropic-format, imajin-ai#1959) — both
 * suites exercise the same `dispatchWithBreakGlass` decision flow
 * (`dispatch.ts`), so they share the same fake token source, body-reading,
 * and abort-simulation helpers rather than each declaring them independently.
 */
import type { TokenSource } from '../src/token-provider.js';

export function fakeTokenSource(tokens: string[]): TokenSource & { calls: number } {
  let i = 0;
  return {
    calls: 0,
    async getToken() {
      this.calls += 1;
      return tokens[Math.min(i, tokens.length - 1)];
    },
    invalidate() {
      i += 1;
    },
  };
}

export async function bodyToText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  return new Response(body).text();
}

/** Resolves the given signal's abort into an AI-SDK-shaped `TimeoutError`, matching a real `fetch()` timeout. */
export function onAbortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      reject(err);
    });
  });
}
