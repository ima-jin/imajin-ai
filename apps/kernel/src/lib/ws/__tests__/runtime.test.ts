import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { provideWsRuntime, boundedWsOperation } = require('../runtime');
const ws = require('../../../../ws-server');
const { forwardSessionEvent } = require('../session-commands');
const { session, update } = vi.hoisted(() => ({ session: vi.fn(), update: vi.fn() }));
vi.mock('@/src/lib/auth/session-resolver', () => ({ resolveKernelSession: session }));
vi.mock('@/src/db', () => ({
  db: { update: () => ({ set: () => ({ where: update }) }) }, profiles: { did: 'did' },
}));
import { registerWsRuntime } from '../register-runtime';
import { createWsToken } from '../../chat/ws-tokens';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
  vi.stubEnv('AUTH_INTERNAL_API_KEY', 'inert-fixture');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  session.mockReset();
  update.mockReset().mockResolvedValue(undefined);
  registerWsRuntime();
});
afterEach(() => {
  provideWsRuntime(undefined);
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
it.each(['did:imajin:person', 'did:imajin:org'])('resolves one-time WS token in-process for effective identity %s with self HTTP blocked', async did => {
  const token = createWsToken(did);
  expect(await ws.authenticateWsToken(token)).toBe(did);
  expect(await ws.authenticateWsToken(token)).toBeNull();
  expect(await ws.authenticateWsToken('unknown')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects expired tokens and shares token storage across module reloads', async () => {
  const token = createWsToken('did:imajin:person');
  vi.resetModules();
  const reloaded = await import('../../chat/ws-tokens');
  expect(reloaded.resolveWsToken(token)).toBe('did:imajin:person');
  const expired = reloaded.createWsToken('did:imajin:org');
  await vi.advanceTimersByTimeAsync(30_001);
  expect(await ws.authenticateWsToken(expired)).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it('uses the canonical session result, never a token-supplied identity or HTTP fallback', async () => {
  session.mockResolvedValue({ data: { did: 'did:imajin:verified' } });
  expect(await ws.authenticateToken('imajin_session', 'inert-cookie')).toBe('did:imajin:verified');
  expect(session).toHaveBeenCalledWith('inert-cookie');
  session.mockResolvedValue({ error: 'Invalid or expired session' });
  expect(await ws.authenticateToken('imajin_session', 'invalid')).toBeNull();
  session.mockRejectedValue(new Error('database unavailable'));
  expect(await ws.authenticateToken('imajin_session', 'inert-cookie')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['did:imajin:person', 'did:imajin:org'])('updates last seen for the authenticated effective DID %s without HTTP', async did => {
  await ws.updateLastSeen(did);
  expect(update).toHaveBeenCalledOnce();
  await ws.broadcastPresenceChange(did, false);
  expect(fetch).not.toHaveBeenCalled();
});
it('bounds a stalled in-process resolver and never falls back to self HTTP', async () => {
  session.mockReturnValue(new Promise(() => undefined));
  const pending = ws.authenticateToken('imajin_session', 'inert-cookie');
  await vi.advanceTimersByTimeAsync(5001);
  expect(await pending).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  const lastSeen = ws.updateLastSeen('did:imajin:person');
  await vi.advanceTimersByTimeAsync(5001);
  await lastSeen;
});
it('cleans the in-process deadline on rejection', async () => {
  await expect(boundedWsOperation(() => { throw new Error('failure'); })).rejects.toThrow('failure');
});
it.each(['headers', 'body'])('bounds session-events %s and preserves authenticated socket identity', async phase => {
  if (phase === 'body') {
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ start() {} })));
  }
  const pending = forwardSessionEvent(
    { authenticated: true, did: 'did:imajin:agent' },
    { type: 'loop.session.send.completed', did: 'did:imajin:other' },
  );
  await vi.advanceTimersByTimeAsync(5001);
  await pending;
  const [, init] = vi.mocked(fetch).mock.calls[0];
  expect(init?.signal?.aborted).toBe(true);
  expect(JSON.parse(String(init?.body)).socketDid).toBe('did:imajin:agent');
});
