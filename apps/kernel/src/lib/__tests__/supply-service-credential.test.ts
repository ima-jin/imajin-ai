/**
 * End-to-end auth-boundary test for #1800 / #1803.
 *
 * #1800 introduced a session-less service credential (`app-service+jwt`) and
 * wired the *real* mint route, the *real* verify route, and the *real*
 * `requireAppAuth` together (only `fetch` is stubbed, to route
 * `requireAppAuth`'s round-trip to the in-process verify handler instead of
 * the network) through the *real* `handleLotGet` — the handler behind
 * `GET /supply/api/lot/{correlationId}`.
 *
 * #1803 rescoped that decision: Ryan (owner) decided session-less app reads
 * of consent-tier data are NOT an intended capability, so `supply:read` (and
 * scopes like it) never became `serviceEligible` — the fence
 * (`packages/auth/src/scope-vocabulary.ts`) ships empty. The webhook use case
 * that motivated #1800 instead falls through the selective-disclosure
 * pipeline (`auth.channel_links`, see `app-authorization-grant.ts` and the
 * per-lot enforcement in `handleLotGet`).
 *
 * This file now pins the CURRENT boundary:
 *   - a service token can never carry `supply:read` at all, no matter what
 *     the app registered — it never reaches the lot route with that scope
 *   - out-of-scope (no supply:read at all) still fails the same way
 *   - a revoked app can no longer mint a credential
 *   - attribution in the verified record still identifies the app principal,
 *     never a borrowed human DID, for whatever scopes a service token *can*
 *     carry
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeypair, crypto, requireAppAuth } from '@imajin/auth';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
}));

const mocks = vi.hoisted(() => {
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));
  const getLotChainMock = vi.fn();
  return { whereMock, fromMock, selectMock, getLotChainMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  registryApps: { appDid: 'registryApps.appDid' },
}));
vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => ({ eq: args }) }));
vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: () => 'lot_test' }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('@imajin/bus', () => ({
  publish: vi.fn(),
  getLotChain: mocks.getLotChainMock,
  recentLotsBySupplier: vi.fn(),
}));

import { POST as mintServiceToken } from '@/app/auth/api/apps/token/service/route';
import { POST as verifyServiceToken } from '@/app/auth/api/apps/token/verify/route';
import { handleLotGet } from '../supply';

const AUTH_SERVICE_URL = 'https://auth.kernel.test/auth';
const APP_DID = 'did:imajin:agrifortress-webhook';
const HUMAN_DID = 'did:imajin:borrowed-human';
const keypair = generateKeypair();

function nextSelect(rows: unknown[]): void {
  mocks.whereMock.mockImplementationOnce(() => Promise.resolve(rows));
}

function registryRow(overrides: Partial<{ status: string; requestedScopes: string[] }> = {}) {
  return {
    appDid: APP_DID,
    publicKey: keypair.publicKey,
    status: overrides.status ?? 'active',
    requestedScopes: overrides.requestedScopes ?? ['supply:read'],
  };
}

async function mintToken(): Promise<Response> {
  const nonce = 'n'.repeat(16);
  const timestamp = new Date().toISOString();
  const challenge = `${APP_DID}:${nonce}:${timestamp}`;
  const signature = crypto.signSync(challenge, keypair.privateKey);
  const req = new Request(`${AUTH_SERVICE_URL}/api/apps/token/service`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appDid: APP_DID, nonce, timestamp, signature }),
  });
  return mintServiceToken(req as never);
}

function lotGetRequest(token: string): Request {
  return new Request('https://kernel.test/supply/api/lot/lot_1', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whereMock.mockReset();
  process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;

  // requireAppAuth's bearer path round-trips through HTTP in production; here
  // we stub `fetch` to hand the request straight to the real verify handler
  // in-process, so the whole mint → verify → route chain runs on real code.
  global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url) === `${AUTH_SERVICE_URL}/api/apps/token/verify`) {
      const req = new Request(String(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: init?.body,
      });
      return verifyServiceToken(req as never);
    }
    throw new Error(`Unexpected fetch to ${String(url)}`);
  }) as unknown as typeof fetch;
});

describe('#1803 — supply:read is fenced out of the session-less service credential', () => {
  it('a service token minted for an app that registered supply:read carries no scopes, and the lot route rejects it', async () => {
    nextSelect([registryRow({ requestedScopes: ['supply:read'] })]);
    const mintRes = await mintToken();
    expect(mintRes.status).toBe(200);
    const { token, scopes } = await mintRes.json();
    expect(scopes).toEqual([]);

    const res = await handleLotGet(lotGetRequest(token) as never, 'lot_1');
    expect(res.status).toBe(403);
    expect(mocks.getLotChainMock).not.toHaveBeenCalled();
  });

  it('out-of-scope fails: a credential minted without supply:read is rejected by the route', async () => {
    nextSelect([registryRow({ requestedScopes: ['supply:write'] })]); // no supply:read
    const mintRes = await mintToken();
    const { token } = await mintRes.json();

    const res = await handleLotGet(lotGetRequest(token) as never, 'lot_1');
    expect(res.status).toBe(403);
    expect(mocks.getLotChainMock).not.toHaveBeenCalled();
  });

  it('revoked credential fails: a revoked app can no longer mint a new credential to read with', async () => {
    nextSelect([registryRow({ status: 'revoked' })]);

    const mintRes = await mintToken();
    expect(mintRes.status).toBe(403);
    const body = await mintRes.json();
    expect(body.token).toBeUndefined();
  });

  it('attribution: the verified record identifies the app principal, never a borrowed human DID, even though scope is empty', async () => {
    nextSelect([registryRow({ requestedScopes: ['supply:read'] })]);
    const mintRes = await mintToken();
    const { token } = await mintRes.json();

    const authResult = await requireAppAuth(
      new Request('https://kernel.test/supply/api/lot/lot_1', {
        headers: { Authorization: `Bearer ${token}` },
      }) as never,
    );

    expect('appAuth' in authResult).toBe(true);
    if (!('appAuth' in authResult)) throw new Error('expected appAuth');
    expect(authResult.appAuth.appDid).toBe(APP_DID);
    expect(authResult.appAuth.userDid).toBe('');
    expect(authResult.appAuth.userDid).not.toBe(HUMAN_DID);
    expect(authResult.appAuth.isServiceToken).toBe(true);
    expect(authResult.appAuth.scopes).toEqual([]);
  });
});
