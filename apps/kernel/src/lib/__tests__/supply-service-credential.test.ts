/**
 * End-to-end auth-boundary test for #1800 / #1803 / catalyst-power/xprize#70.
 *
 * #1800 introduced a session-less service credential (`app-service+jwt`) and
 * wired the *real* mint route, the *real* verify route, and the *real*
 * `requireAppAuth` together (only `fetch` is stubbed, to route
 * `requireAppAuth`'s round-trip to the in-process verify handler instead of
 * the network) through the *real* `handleLotGet` — the handler behind
 * `GET /supply/api/lot/{correlationId}`.
 *
 * #1803 rescoped that decision: Ryan (owner) decided session-less app reads
 * of consent-tier data needed a per-lot gate first, so `supply:read` shipped
 * `serviceEligible: false` and a service token could never carry it — the
 * webhook use case fell through the selective-disclosure pipeline
 * (`auth.channel_links`, see `app-authorization-grant.ts`) instead, with the
 * per-lot enforcement landing in `handleLotGet` and a backfill migration
 * (#1806, migration 0090).
 *
 * xprize#70 is the owner-signed-off flip step now that #1806 has merged:
 * `supply:read` is `serviceEligible: true` in `packages/auth/src/scope-vocabulary.ts`.
 * This file now pins the CURRENT boundary, which is deliberately still
 * consent-backed even though the token-shape fence opened up:
 *   - a service token minted for an app that registered `supply:read` now
 *     carries the scope
 *   - reaching a given lot with that token STILL requires an active
 *     `channel_links` grant of `supply:read` from the lot's own
 *     `originatingDid` — the per-lot gate, not the token shape, is what
 *     authorizes the read
 *   - no grant from that supplier → 403, even with a service-eligible scope
 *   - out-of-scope (no supply:read at all) still fails before the grant check
 *   - a revoked app can no longer mint a credential
 *   - attribution in the verified record still identifies the app principal,
 *     never a borrowed human DID
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
  const hasAppAuthorizationGrantMock = vi.fn();
  const sqlTagMock = vi.fn(async () => []);
  return { whereMock, fromMock, selectMock, getLotChainMock, hasAppAuthorizationGrantMock, sqlTagMock };
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
// #1803 item 3's DID-attributed audit write (handleLotGet -> auditSupplyLotRead)
// now runs on every reachable lot read in this suite (the grant check is no
// longer short-circuited by an empty scope set) — keep it inert here.
vi.mock('@imajin/db', () => ({ getClient: () => mocks.sqlTagMock }));
// The per-lot gate (#1806) is exercised by its own unit tests
// (app-authorization-grant.test.ts, supply-api.test.ts); here it is mocked so
// this suite stays focused on the mint → verify → route chain's real code
// while still proving the gate is consulted and its answer decides the outcome.
vi.mock('@/src/lib/auth/app-authorization-grant', () => ({
  hasAppAuthorizationGrant: mocks.hasAppAuthorizationGrantMock,
}));

import { POST as mintServiceToken } from '@/app/auth/api/apps/token/service/route';
import { POST as verifyServiceToken } from '@/app/auth/api/apps/token/verify/route';
import { handleLotGet } from '../supply';

const AUTH_SERVICE_URL = 'https://auth.kernel.test/auth';
const APP_DID = 'did:imajin:agrifortress-webhook';
const HUMAN_DID = 'did:imajin:borrowed-human';
const SUPPLIER_DID = 'did:imajin:agrifortress-supplier';
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
  mocks.hasAppAuthorizationGrantMock.mockReset();
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

function lotOf(originatingDid: string) {
  mocks.getLotChainMock.mockResolvedValue({
    lot: { correlationId: 'lot_1', originatingDid, status: 'listed' },
    stages: [{ stage: 'declared' }],
  });
}

describe('xprize#70 — supply:read is service-eligible, but the per-lot channel_links grant still authorizes the read', () => {
  it('mints a service token WITH supply:read, and a channel_links grant from the lot\'s originatingDid lets it read the lot (200)', async () => {
    nextSelect([registryRow({ requestedScopes: ['supply:read'] })]);
    const mintRes = await mintToken();
    expect(mintRes.status).toBe(200);
    const { token, scopes } = await mintRes.json();
    expect(scopes).toEqual(['supply:read']);

    lotOf(SUPPLIER_DID);
    mocks.hasAppAuthorizationGrantMock.mockResolvedValue(true);

    const res = await handleLotGet(lotGetRequest(token) as never, 'lot_1');
    expect(res.status).toBe(200);
    expect(mocks.hasAppAuthorizationGrantMock).toHaveBeenCalledWith(APP_DID, SUPPLIER_DID, 'supply:read');
  });

  it('mints a service token WITH supply:read, but with NO channel_links grant from the lot supplier the read is still rejected (403)', async () => {
    // The flip does not reopen ungoverned session-less reads: the per-lot gate
    // (#1806), not the token's scope shape, is what authorizes a given read.
    nextSelect([registryRow({ requestedScopes: ['supply:read'] })]);
    const mintRes = await mintToken();
    const { token, scopes } = await mintRes.json();
    expect(scopes).toEqual(['supply:read']);

    lotOf(SUPPLIER_DID);
    mocks.hasAppAuthorizationGrantMock.mockResolvedValue(false);

    const res = await handleLotGet(lotGetRequest(token) as never, 'lot_1');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/supply:read grant/i);
    expect(mocks.getLotChainMock).toHaveBeenCalled();
    expect(mocks.hasAppAuthorizationGrantMock).toHaveBeenCalledWith(APP_DID, SUPPLIER_DID, 'supply:read');
  });

  it('out-of-scope fails: a credential minted without supply:read is rejected before the grant check even runs', async () => {
    nextSelect([registryRow({ requestedScopes: ['supply:write'] })]); // no supply:read
    const mintRes = await mintToken();
    const { token } = await mintRes.json();

    const res = await handleLotGet(lotGetRequest(token) as never, 'lot_1');
    expect(res.status).toBe(403);
    expect(mocks.getLotChainMock).not.toHaveBeenCalled();
    expect(mocks.hasAppAuthorizationGrantMock).not.toHaveBeenCalled();
  });

  it('revoked credential fails: a revoked app can no longer mint a new credential to read with', async () => {
    nextSelect([registryRow({ status: 'revoked' })]);

    const mintRes = await mintToken();
    expect(mintRes.status).toBe(403);
    const body = await mintRes.json();
    expect(body.token).toBeUndefined();
  });

  it('attribution: the verified record identifies the app principal, never a borrowed human DID, and now carries supply:read', async () => {
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
    expect(authResult.appAuth.scopes).toEqual(['supply:read']);
  });
});
