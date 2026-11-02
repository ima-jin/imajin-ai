import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_COOKIE_NAME } from '@imajin/config';
import { requireAuth } from '../src/require-auth';
import { provideSessionResolver } from '../src/session-resolver';
import { setVaultInternalApiKey } from './support/internal-post-test-env';
const identity = { did: 'did:imajin:person', scope: 'actor' };
beforeEach(() => {
  vi.useFakeTimers();
  Reflect.deleteProperty(globalThis, Symbol.for('@imajin/auth/session-resolver/v1'));
  vi.stubEnv('AUTH_SERVICE_URL', 'http://localhost:7000/auth');
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  setVaultInternalApiKey('test-only-internal-key');
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('@imajin/auth/session-resolver/v1'));
  setVaultInternalApiKey(undefined);
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
it.each(['cookie', 'bearer', 'acting-as'])('fails closed within 5s on a stalled %s upstream', async kind => {
  if (kind === 'acting-as') provideSessionResolver(async () => identity);
  const headers = kind === 'bearer'
    ? { authorization: 'Bearer test-only-token' }
    : { cookie: `${SESSION_COOKIE_NAME}=test-only-session`, ...(kind === 'acting-as' ? { 'x-acting-as': 'did:imajin:org' } : {}) };
  const pending = requireAuth(new Request('http://kernel.test/private', { headers }), { service: 'jin' });
  await vi.advanceTimersByTimeAsync(5_001);
  const result = await pending;
  expect(result).toMatchObject({ status: kind === 'acting-as' ? 403 : 503 });
  expect(vi.getTimerCount()).toBe(0);
});
it('has no remaining raw internal fetch calls in auth or the WS entrypoint', () => {
  const root = new URL('../src/', import.meta.url);
  const files = readdirSync(root, { recursive: true }).filter(name => name.endsWith('.ts'));
  for (const name of files) {
    const source = readFileSync(new URL(name.replaceAll('\\', '/'), root), 'utf8');
    // kernel-webhook's custom discovery fetch already races headers + JSON
    // against its own explicit timeout, preserving its DISCOVERY error contract.
    expect(source, name).not.toMatch(/\bawait fetch\(/);
  }
  const ws = readFileSync(join(process.cwd(), 'apps/kernel/ws-server.js'), 'utf8');
  expect(ws).not.toMatch(/\bawait fetch\(/);
  expect(ws.match(/\bawait internalFetch\(/g)).toHaveLength(8);
});
