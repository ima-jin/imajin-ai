/**
 * Run unchanged on the baseline and branch:
 * pnpm exec vitest run packages/auth/tests/session-stall-repro.test.ts --reporter=verbose
 * REPRO_DEFAULT_HEADERS=1 also waits for native fetch's default headers timeout.
 * No production keys, sessions, database, or live services are used.
 */
import { createServer } from 'node:http';
import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

it('settles every auth handler when its loopback session upstream withholds headers', async () => {
  const { requireAuth } = await import('../src/require-auth');
  const { createSessionToken } = await import('../../../apps/kernel/src/lib/auth/jwt');
  // The same helper the kernel uses, with an ephemeral, test-only signing key.
  const token = await createSessionToken({ sub: 'did:imajin:stall-test', scope: 'actor' });
  const nativeTimeout = process.env.REPRO_DEFAULT_HEADERS === '1';
  const boundMs = nativeTimeout ? 310_000 : 7_000;
  const count = 6;
  const server = createServer({ requestTimeout: 1_000, headersTimeout: 1_000 }, (req) => {
    req.resume(); // Consume the entire incoming request; never send response headers.
  });
  const causes: string[] = [];
  const onError = (message: unknown) => {
    const code = (message as { error?: { code?: string } }).error?.code;
    if (code) causes.push(code);
  };
  const errors = channel('undici:request:error');
  errors.subscribe(onError);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  vi.stubEnv('AUTH_SERVICE_URL', `http://127.0.0.1:${address.port}/auth`);
  const results: unknown[] = [];
  const durations: number[] = [];
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const requests = Array.from({ length: count }, async () => {
      const result = await requireAuth(new Request('http://kernel.test/chat/api/conversations/unread', {
        headers: { cookie: `imajin_session=${token}` },
      }));
      results.push(result);
      durations.push(Math.round(performance.now() - started));
    });
    await Promise.race([
      Promise.all(requests),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, boundMs); }),
    ]);
    console.info(JSON.stringify({
      node: process.version, undici: process.versions.undici, requests: count,
      boundMs, settled: results.length, stuck: count - results.length,
      durationMs: Math.round(performance.now() - started), durations,
      serverRequestTimeoutMs: server.requestTimeout, causeCodes: [...new Set(causes)],
    }));
    expect(results, 'handlers must settle within the bound').toHaveLength(count);
    expect(results).toEqual(Array.from({ length: count }, () => ({
      error: 'Auth service unavailable', status: 503,
    })));
    if (nativeTimeout) expect(causes).toContain('UND_ERR_HEADERS_TIMEOUT');
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    errors.unsubscribe(onError);
    vi.unstubAllEnvs();
  }
}, 320_000);
