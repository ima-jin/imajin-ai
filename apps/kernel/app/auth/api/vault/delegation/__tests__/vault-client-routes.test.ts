/**
 * Route-existence guard for `loadFromVault` (#2624).
 *
 * `loadFromVault` (`packages/auth/src/vault-client.ts`) derives every URL from
 * `AUTH_SERVICE_URL`, which is `http://localhost:<port>/auth` in every
 * `.env.local`. The delegation routes originally existed only under
 * `/api/vault/delegation/*`, so every grant lookup 404'd and nothing noticed.
 *
 * This test runs the REAL client against a recording `fetch`, collects every
 * vault delegation URL it builds (grants list, fetch, ack) and asserts that
 * each one resolves — through the Next.js app-router file layout — to a
 * `route.ts` that exports a handler for the HTTP method the client uses. It
 * also asserts each mounted handler IS the original handler (a pure
 * re-export), so the two mounts can never diverge in behaviour either.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(),
  authErrorResponse: vi.fn(),
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));
vi.mock('@/src/lib/vault', () => ({
  listGrantsForGrantee: vi.fn(),
  fetchGrantSecret: vi.fn(),
  ackGrant: vi.fn(),
}));
vi.mock('@/src/lib/vault/errors', () => ({ toVaultErrorResponse: vi.fn() }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { loadFromVault } from '../../../../../../../../packages/auth/src/vault-client';

/** `apps/kernel/app` — the Next.js app-router root a URL path maps onto. */
const APP_ROOT = resolve(__dirname, '../../../../..');
const AUTH_SERVICE_URL = 'http://localhost:3000/auth';
const MOUNT_PREFIX = '/auth';
const DELEGATION_PATH = '/api/vault/delegation/';
const GRANT_ID = 'vdg_route_guard';

interface RecordedCall {
  method: string;
  pathname: string;
}

type RouteModule = Record<string, unknown>;

function isDynamicSegmentDir(entry: { name: string; isDirectory(): boolean }): boolean {
  return entry.isDirectory() && /^\[[^\]]+\]$/.test(entry.name);
}

/** The directory for one URL path segment: an exact match, else a `[param]` directory. */
function childDirectory(dir: string, segment: string): string | null {
  const exact = join(dir, segment);
  if (existsSync(exact) && statSync(exact).isDirectory()) return exact;
  const dynamic = readdirSync(dir, { withFileTypes: true }).find(isDynamicSegmentDir);
  return dynamic ? join(dir, dynamic.name) : null;
}

/** Maps a URL pathname to the `route.ts` Next.js would serve it from, or `null` when no such route exists. */
function findRouteFile(pathname: string): string | null {
  let dir = APP_ROOT;
  for (const segment of pathname.split('/').filter(Boolean)) {
    const next = childDirectory(dir, segment);
    if (!next) return null;
    dir = next;
  }
  const file = join(dir, 'route.ts');
  return existsSync(file) ? file : null;
}

/** Runs the real client end to end against a recording fetch and returns every vault delegation call it made. */
async function recordVaultCalls(): Promise<RecordedCall[]> {
  const recorded: RecordedCall[] = [];
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    if (pathname.endsWith('/api/challenge')) {
      return new Response(JSON.stringify({ challengeId: 'ch_1', challenge: 'raw-challenge' }), { status: 200 });
    }
    if (pathname.endsWith('/api/authenticate')) {
      return new Response(JSON.stringify({ token: 'imajin_tok_route_guard' }), { status: 200 });
    }
    recorded.push({ method: init?.method ?? 'GET', pathname });
    if (pathname.endsWith('/grants')) {
      return new Response(JSON.stringify({ grants: [{ grantId: GRANT_ID, status: 'active' }] }), { status: 200 });
    }
    if (pathname.endsWith('/fetch')) {
      return new Response(JSON.stringify({ ok: true, field: 'internal-secret:route-guard', value: 'v' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchStub);

  try {
    const result = await loadFromVault({
      resolveGrantByPurpose: 'route.guard',
      purpose: 'route-guard',
      keys: [{ key: 'ROUTE_GUARD', onMissing: 'fail' }],
      identity: { did: 'did:imajin:routeguard0000', privateKey: 'a'.repeat(64) },
      authServiceUrl: AUTH_SERVICE_URL,
    });
    result.acks.ROUTE_GUARD!.used('route-guard');
    await vi.waitFor(() => expect(recorded.some((call) => call.pathname.endsWith('/ack'))).toBe(true));
  } finally {
    vi.unstubAllGlobals();
  }
  return recorded;
}

async function importRoute(file: string): Promise<RouteModule> {
  return (await import(/* @vite-ignore */ file)) as RouteModule;
}

describe('loadFromVault URLs resolve to mounted kernel routes (#2624)', () => {
  it('exercises the grants list, fetch and ack paths under the /auth mount', async () => {
    const calls = await recordVaultCalls();

    expect(calls.map((call) => `${call.method} ${call.pathname}`)).toEqual([
      'GET /auth/api/vault/delegation/grants',
      `POST /auth/api/vault/delegation/grants/${GRANT_ID}/fetch`,
      `POST /auth/api/vault/delegation/grants/${GRANT_ID}/ack`,
    ]);
  });

  it('resolves every URL the client builds to a route.ts exporting the HTTP method it uses', async () => {
    const calls = await recordVaultCalls();
    expect(calls).toHaveLength(3);

    for (const call of calls) {
      const file = findRouteFile(call.pathname);
      expect(file, `no route.ts serves ${call.method} ${call.pathname}`).not.toBeNull();
      const handler = (await importRoute(file as string))[call.method];
      expect(typeof handler, `${call.pathname} does not export ${call.method}`).toBe('function');
    }
  });

  it('mounts each route as a pure re-export of the original /api handler', async () => {
    const calls = await recordVaultCalls();

    for (const call of calls) {
      const mounted = findRouteFile(call.pathname);
      const original = findRouteFile(call.pathname.slice(MOUNT_PREFIX.length));
      expect(original, `no original /api route for ${call.pathname}`).not.toBeNull();
      expect(mounted).not.toBe(original);
      expect(call.pathname).toContain(DELEGATION_PATH);

      const mountedHandler = (await importRoute(mounted as string))[call.method];
      const originalHandler = (await importRoute(original as string))[call.method];
      expect(mountedHandler).toBe(originalHandler);
    }
  });

  it('reports no route for a path that is not mounted', () => {
    expect(findRouteFile('/auth/api/vault/delegation/not-a-route')).toBeNull();
  });
});
