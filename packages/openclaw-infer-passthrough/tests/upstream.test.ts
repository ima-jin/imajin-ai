/**
 * TTFB-vs-total-duration regression coverage for `fetchWithTtfbTimeout`
 * (imajin-ai#2342): the abort must only ever be able to fire before the
 * first byte arrives, never mid-stream.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { forwardToKernel, UpstreamTimeoutError } from '../src/upstream.js';
import { onAbortRejection } from './dispatch-test-support.js';

describe('forwardToKernel — TTFB timeout bounds time-to-first-byte only', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('completes a stream whose body chunks arrive well past the TTFB timeout', async () => {
    const timeoutMs = 20;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('chunk-1 '));
        await new Promise((resolve) => setTimeout(resolve, timeoutMs * 4));
        controller.enqueue(encoder.encode('chunk-2'));
        controller.close();
      },
    });

    const fetchMock = vi.fn(async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await forwardToKernel('https://kernel.test', 'tok', '{}', timeoutMs);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('chunk-1 chunk-2');
  });

  it('raises UpstreamTimeoutError when the upstream sends nothing before the TTFB timeout', async () => {
    const timeoutMs = 20;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => onAbortRejection(init?.signal as AbortSignal));
    vi.stubGlobal('fetch', fetchMock);

    await expect(forwardToKernel('https://kernel.test', 'tok', '{}', timeoutMs)).rejects.toThrow(UpstreamTimeoutError);
  });
});
