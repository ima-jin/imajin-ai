/**
 * Tests for POST /auth/api/apps/token/service (#1141, hardened for #1800).
 *
 * This is the issuance endpoint for the session-less service credential: a
 * registered app proves possession of its own keypair and receives a token
 * attributed to its own DID, scoped to whatever it registered — no human
 * attestation involved. Revocation is enforced here, at mint time: a
 * `revoked` app can never mint a new credential, bounding how long a
 * compromised or retired app can keep reading the kernel to this token's
 * short TTL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeypair, crypto } from '@imajin/auth';
import { verifyAppToken } from '@/src/lib/auth/jwt';

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
  return { whereMock, fromMock, selectMock };
});

function nextSelect(rows: unknown[]): void {
  mocks.whereMock.mockImplementationOnce(() => Promise.resolve(rows));
}

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  registryApps: {
    appDid: 'registryApps.appDid',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
}));

vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { POST } from '../route';

const keypair = generateKeypair();
const APP_DID = 'did:imajin:agrifortress-webhook';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/auth/api/apps/token/service', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function signedBody(overrides: Partial<{ appDid: string; nonce: string; timestamp: string }> = {}) {
  const appDid = overrides.appDid ?? APP_DID;
  const nonce = overrides.nonce ?? 'n'.repeat(16);
  const timestamp = overrides.timestamp ?? new Date().toISOString();
  const challenge = `${appDid}:${nonce}:${timestamp}`;
  const signature = crypto.signSync(challenge, keypair.privateKey);
  return { appDid, nonce, timestamp, signature };
}

function activeApp(requestedScopes: string[]) {
  return { appDid: APP_DID, publicKey: keypair.publicKey, status: 'active', requestedScopes };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whereMock.mockReset();
});

describe('POST /auth/api/apps/token/service — issuance (#1800, supply:read flipped by xprize#70)', () => {
  it('mints a token attributed to the app DID, carrying supply:read now that it is service-eligible (xprize#70)', async () => {
    // catalyst-power/xprize#70 flips supply:read to serviceEligible: a
    // session-less service token for an app that registered it now mints WITH
    // the scope. The per-lot channel_links gate (#1806) is what still governs
    // whether any given read succeeds — see supply-service-credential.test.ts.
    nextSelect([activeApp(['supply:read'])]);

    const res = await POST(makeRequest(signedBody()) as never);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.scopes).toEqual(['supply:read']);

    const payload = await verifyAppToken(body.token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe(APP_DID);
    expect(payload!.azp).toBe(APP_DID);
    expect(payload!.isServiceToken).toBe(true);
    expect(payload!.attestationId).toBe('');
    expect(payload!.scope).toBe('supply:read');
  });

  it('clamps unknown/stale scopes out of the vocabulary rather than minting them', async () => {
    nextSelect([activeApp(['supply:read', 'not-a-real-scope'])]);

    const res = await POST(makeRequest(signedBody()) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    // 'not-a-real-scope' fails validateScopes; 'supply:read' now clears both
    // validateScopes and the serviceEligible fence.
    expect(body.scopes).toEqual(['supply:read']);
  });

  it('fences supply:write out — registering it is not enough to mint it on a service token', async () => {
    nextSelect([activeApp(['supply:write'])]);

    const res = await POST(makeRequest(signedBody()) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.scopes).toEqual([]);
    expect(body.scopes).not.toContain('supply:write');
  });

  it('mints supply:read but continues to clamp supply:write out when an app requests both (one-scope flip, not the pair)', async () => {
    nextSelect([activeApp(['supply:read', 'supply:write'])]);

    const res = await POST(makeRequest(signedBody()) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.scopes).toEqual(['supply:read']);
    expect(body.scopes).not.toContain('supply:write');
  });
});

describe('POST /auth/api/apps/token/service — revocation is enforced at mint time (#1800)', () => {
  it('refuses to mint a new credential for a revoked app', async () => {
    nextSelect([{ ...activeApp(['supply:read']), status: 'revoked' }]);

    const res = await POST(makeRequest(signedBody()) as never);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not active/i);
  });

  it('returns 404 for an unregistered app DID — nothing to revoke or mint against', async () => {
    nextSelect([]);

    const res = await POST(makeRequest(signedBody()) as never);
    expect(res.status).toBe(404);
  });
});

describe('POST /auth/api/apps/token/service — proof of possession', () => {
  it('rejects a signature that does not match the registered public key', async () => {
    nextSelect([activeApp(['supply:read'])]);
    const otherKeypair = generateKeypair();
    const body = signedBody();
    const challenge = `${body.appDid}:${body.nonce}:${body.timestamp}`;
    body.signature = crypto.signSync(challenge, otherKeypair.privateKey);

    const res = await POST(makeRequest(body) as never);
    expect(res.status).toBe(401);
  });

  it('rejects a stale timestamp outside the clock-skew window', async () => {
    nextSelect([activeApp(['supply:read'])]);
    const staleTimestamp = new Date(Date.now() - 5 * 60_000).toISOString();

    const res = await POST(makeRequest(signedBody({ timestamp: staleTimestamp })) as never);
    expect(res.status).toBe(401);
  });

  it('rejects a nonce shorter than 16 characters', async () => {
    const res = await POST(makeRequest(signedBody({ nonce: 'short' })) as never);
    expect(res.status).toBe(400);
    expect(mocks.selectMock).not.toHaveBeenCalled();
  });

  it('rejects a request missing required fields', async () => {
    const res = await POST(makeRequest({ appDid: APP_DID }) as never);
    expect(res.status).toBe(400);
  });
});
