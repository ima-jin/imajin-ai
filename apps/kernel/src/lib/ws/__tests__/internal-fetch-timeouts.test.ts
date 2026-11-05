import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const wsTransport = require('../../../../ws-server.js') as Record<string, (...args: unknown[]) => Promise<unknown>>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('PORT', '7000');
  vi.stubEnv('AUTH_INTERNAL_API_KEY', 'test-only-key');
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
it.each([
  ['authenticateToken', ['imajin_session', 'test-only-session'], null],
  ['authenticateWsToken', ['test-only-token'], null],
  ['updateLastSeen', ['did:imajin:person'], undefined],
  ['verifyAgentDelegation', ['did:imajin:agent', 'did:imajin:person'], false],
  ['releaseWsClaims', ['did:imajin:person'], undefined],
  ['ackNotification', ['notification-id', 'did:imajin:person'], undefined],
])('bounds WS %s and preserves its fail-closed result', async (name, args, expected) => {
  const pending = wsTransport[name as string](...(args as unknown[]));
  await vi.advanceTimersByTimeAsync(5_001);
  expect(await pending).toBe(expected);
  const [, init] = vi.mocked(fetch).mock.calls[0];
  expect(init?.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it('bounds WS notification backlog and propagates a typed error to its existing replayer catch', async () => {
  const pending = expect(wsTransport.fetchNotificationBacklog('did:imajin:person'))
    .rejects.toMatchObject({ name: 'InternalFetchError', code: 'INTERNAL_FETCH_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(5_001);
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});
