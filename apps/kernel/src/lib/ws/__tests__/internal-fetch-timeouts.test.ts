import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Execute the actual CJS entrypoint, exposing private functions in the test VM
// only. Production exports are unchanged; every call uses the real shared helper.
const path = resolve('apps/kernel/ws-server.js');
const source = readFileSync(path, 'utf8');
const module = { exports: {} as Record<string, (...args: unknown[]) => Promise<unknown>> };
runInNewContext(`${source}\nObject.assign(module.exports, {
  authenticateToken, authenticateWsToken, updateLastSeen, broadcastPresenceChange,
  verifyAgentDelegation, fetchNotificationBacklog, releaseWsClaims, ackNotification,
});`, {
  require: createRequire(path), module, console, process, URL, setTimeout, clearTimeout,
});
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
  ['broadcastPresenceChange', ['did:imajin:person', false], undefined],
  ['verifyAgentDelegation', ['did:imajin:agent', 'did:imajin:person'], false],
  ['releaseWsClaims', ['did:imajin:person'], undefined],
  ['ackNotification', ['notification-id', 'did:imajin:person'], undefined],
])('bounds WS %s and preserves its fail-closed result', async (name, args, expected) => {
  const pending = module.exports[name as string](...(args as unknown[]));
  await vi.advanceTimersByTimeAsync(5_001);
  expect(await pending).toBe(expected);
  const [, init] = vi.mocked(fetch).mock.calls[0];
  expect(init?.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it('bounds WS notification backlog and propagates a typed error to its existing replayer catch', async () => {
  const pending = expect(module.exports.fetchNotificationBacklog('did:imajin:person'))
    .rejects.toMatchObject({ name: 'InternalFetchError', code: 'INTERNAL_FETCH_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(5_001);
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});
