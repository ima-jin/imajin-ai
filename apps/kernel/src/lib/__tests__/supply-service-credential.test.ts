/**
 * End-to-end auth-boundary test for #1800 / #1803 / xprize#70.
 *
 * #1800 introduced a session-less service credential (`app-service+jwt`) and
 * wired the *real* mint route, the *real* verify route, and the *real*
 * `requireAppAuth` together (only `fetch` is stubbed, to route
 * `requireAppAuth`'s round-trip to the in-process verify handler instead of
 * the network) through the *real* `handleLotGet` — the handler behind
 * `GET /supply/api/lot/{correlationId}`.
 *
 * #1803 rescoped that decision: Ryan (owner) decided a session-less app read
 * must never be sufficient on its own, so `handleLotGet` grew a second, finer
 * gate — `hasAppAuthorizationGrant` — requiring an active `channel_links` row
 * projecting THIS lot's originating supplier's consent to the calling app,
 * on top of the coarse token-scope check. #1803 shipped with the fence
 * (`packages/auth/src/scope-vocabulary.ts`) empty, so no token could carry
 * `supply:read` at all yet.
 *
 * xprize#70 is the owner-signed-off flip: `supply:read` is now
 * `serviceEligible`, so a service token CAN carry it. The fine per-lot
 * `channel_links` gate added by #1803 is what still stands between that and
 * an actual read — this file pins the CURRENT boundary:
 *   - a service token for an app that registered `supply:read` now mints
 *     with that scope, and passes the coarse gate in `handleLotGet`
 *   - WITH an active `channel_links` grant of `supply:read` from the lot's
 *     originating supplier to the calling app — the read succeeds (200)
 *   - WITHOUT that grant — the read is still rejected (403), even though the
 *     token carries the scope
 *   - out-of-scope (no `supply:read` on the token at all) still fails the
 *     coarse gate before the grant is even checked
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
  return { whereMock, fromMock, selectMock, getLotChainMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  registryApps: { appDid: 'registryApps.appDid' },
  channelLinks: {
    channel: 'channelLinks.channel',
    channelUid: 'channelLinks.channelUid',
    did: 'channelLinks.did',
    appDid: 'channelLinks.appDid',
    status: 'channelLinks.status',
    scopes: 'channelLinks.scopes',
  },
}));
vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
}));
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
const SUPPLIER_DID = 'did:imajin:lot-originating-supplier';
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

/** A minimal `LotChain` (see `@imajin/bus`'s `getLotChain`) for lot_1, originated by `originatingDid`. */
function lotChain(originatingDid: string = SUPPLIER_DID) {
  return {
    lot: {
      correlationId: 'lot_1',
      originatingDid,
      commodity: 'eggs',
      status: 'listed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    stages: [],
  };
}

/** An active `channel_links` row (see `hasAppAuthorizationGrant`) granting `scopes` from the query. */
function channelLinkGrantRow(scopes: string[]): Array<{ scopes: string[] }> {
  return [{ scopes }];
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

describe('xprize#70 — supply:read is serviceEligible, gated per-lot by a channel_links grant', () => {
  it('WITH an active channel_links grant from the lot\'s originating supplier on supply:read, the read succeeds (200)', async () => {
    nextSelect([registryRow({ requestedScopes: ['supply:read'] })]);
    const mintRes = await mintToken();
    expect(mintRes.status).toBe(200);
    const { token, scopes } = await mintRes.json();
    // xprize#70: the coarse fence now lets supply:read through onto the token.
    expect(scopes).toEqual(['supply:read']);

    mocks.getLotChainMock.mockResolvedValueOnce(lotChain(SUPPLIER_DID));
    // hasAppAuthorizationGrant's channel_links lookup: an active grant from
    // this lot's originating supplier to this app, on supply:read.
    nextSelect(channelLinkGrantRow(['supply:read']));

    const res = await handleLotGet(lotGetRequest(token) as never, 'lot_1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lot.originatingDid).toBe(SUPPLIER_DID);
  });

  it('WITHOUT that channel_links grant, the read is still rejected (403) even though the token carries supply:read', async () => {
    nextSelect([registryRow({ requestedScopes: ['supply:read'] })]);
    const mintRes = await mintToken();
    const { token, scopes } = await mintRes.json();
    expect(scopes).toEqual(['supply:read']);

    mocks.getLotChainMock.mockResolvedValueOnce(lotChain(SUPPLIER_DID));
    // No active channel_links row for this (appDid, supplierDid) pair.
    nextSelect([]);

    const res = await handleLotGet(lotGetRequest(token) as never, 'lot_1');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/lacks a supply:read grant/i);
  });

  it('out-of-scope fails: a credential minted without supply:read is rejected by the route before the grant is even checked', async () => {
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

  it('attribution: the verified record identifies the app principal, never a borrowed human DID, now that supply:read is carried', async () => {
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
    // xprize#70: no longer empty — the coarse fence now lets this through;
    // it is the per-lot channel_links grant (not attribution) that gates reads.
    expect(authResult.appAuth.scopes).toEqual(['supply:read']);
  });
});
