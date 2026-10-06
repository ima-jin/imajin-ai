/**
 * Signed-request verification on PUT /profile/api/profile/:id (#2564).
 *
 * `verifySignedRequest` / `validateSignatureIfPresent` lost their `async` (they
 * never awaited). This pins every rejection path so a sync throw or a
 * Promise-vs-value slip would show up as a changed status code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';

ed.hashes.sha512 = sha512;

const {
  mockFindFirst,
  mockRequireAuth,
  mockResolveActingDid,
  mockSelectLimit,
  mockSet,
  mockUpdateReturning,
} = vi.hoisted(() => {
  const mockFindFirst = vi.fn();
  const mockRequireAuth = vi.fn();
  const mockResolveActingDid = vi.fn();
  const mockSelectLimit = vi.fn();
  const mockUpdateReturning = vi.fn();
  const mockSet = vi.fn((_updates: Record<string, unknown>) => ({
    where: () => ({ returning: mockUpdateReturning }),
  }));
  return { mockFindFirst, mockRequireAuth, mockResolveActingDid, mockSelectLimit, mockSet, mockUpdateReturning };
});

vi.mock('@/src/db', () => ({
  db: {
    query: { profiles: { findFirst: mockFindFirst } },
    select: () => ({ from: () => ({ where: () => ({ limit: mockSelectLimit }) }) }),
    update: () => ({ set: mockSet }),
    insert: () => ({ values: vi.fn(() => Promise.resolve([])) }),
  },
  profiles: {},
  identityMembers: {},
  identities: {},
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  requireAppAuth: vi.fn(),
  resolveActingDid: mockResolveActingDid,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({
  publish: vi.fn(() => Promise.resolve()),
  broker: vi.fn(),
  isBrokerRelease: vi.fn(() => false),
}));

vi.mock('@imajin/fair', () => ({
  validateAgentPricingManifest: vi.fn(() => ({ valid: true })),
}));

vi.mock('@/src/lib/vault', () => ({
  loadAndUnseal: vi.fn(() => Promise.reject(new Error('not needed in these tests'))),
}));

vi.mock('@/src/lib/profile/vault-contacts', () => ({
  processEmailUpdate: vi.fn(() => Promise.resolve()),
  processPhoneUpdate: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsOptions: () => new Response(null, { status: 204 }),
  corsHeaders: () => ({}),
}));

vi.mock('@/src/lib/kernel/session', () => ({
  getSessionFromCookies: vi.fn(() => Promise.resolve(null)),
}));

import { PUT } from '../route';

const secretKey = new Uint8Array(32).fill(7);
const publicKey = ed.getPublicKey(secretKey);
const SIGNER_DID = `did:imajin:${bs58.encode(publicKey)}`;
const OTHER_DID = 'did:imajin:someone-else';

const toHex = (bytes: Uint8Array) => Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

function signedRequest(opts: {
  body?: string;
  timestamp?: string;
  did?: string | null;
  signature?: string;
  signWith?: string;
}): NextRequest {
  const body = opts.body ?? JSON.stringify({ displayName: 'New Name' });
  const timestamp = opts.timestamp ?? String(Date.now());
  const signature =
    opts.signature ?? toHex(ed.sign(new TextEncoder().encode(`${opts.signWith ?? timestamp}:${body}`), secretKey));
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-signature': signature };
  if (opts.timestamp !== '') headers['x-timestamp'] = timestamp;
  if (opts.did !== null) headers['x-did'] = opts.did ?? SIGNER_DID;
  return new NextRequest(`https://kernel.test/profile/api/profile/${SIGNER_DID}`, {
    method: 'PUT',
    body,
    headers,
  });
}

const params = () => ({ params: Promise.resolve({ id: SIGNER_DID }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: SIGNER_DID } });
  mockResolveActingDid.mockReturnValue(SIGNER_DID);
  mockFindFirst.mockResolvedValue({ did: SIGNER_DID });
  mockSelectLimit.mockResolvedValue([{ scope: 'actor' }]);
  mockUpdateReturning.mockResolvedValue([{ did: SIGNER_DID }]);
});

async function errorOf(res: Response): Promise<string> {
  return (await res.json()).error as string;
}

describe('PUT /profile/api/profile/:id — signed request verification', () => {
  it('accepts a valid signature from the authenticated DID', async () => {
    const res = await PUT(signedRequest({}), params());
    expect(res.status).toBe(200);
  });

  it('rejects when the timestamp header is missing', async () => {
    const res = await PUT(signedRequest({ timestamp: '', signature: 'abcd' }), params());
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toMatch(/Missing signature headers/);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('rejects when the DID header is missing', async () => {
    const res = await PUT(signedRequest({ did: null }), params());
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toMatch(/Missing signature headers/);
  });

  it('rejects a timestamp older than 5 minutes', async () => {
    const res = await PUT(signedRequest({ timestamp: String(Date.now() - 6 * 60 * 1000) }), params());
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toMatch(/timestamp out of range/);
  });

  it('rejects a timestamp too far in the future', async () => {
    const res = await PUT(signedRequest({ timestamp: String(Date.now() + 60_000) }), params());
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toMatch(/timestamp out of range/);
  });

  it('rejects a non-numeric timestamp', async () => {
    const res = await PUT(signedRequest({ timestamp: 'not-a-number', signature: 'abcd' }), params());
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toMatch(/timestamp out of range/);
  });

  it('rejects a DID that is not did:imajin:', async () => {
    const res = await PUT(signedRequest({ did: 'did:web:example.com' }), params());
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toMatch(/Invalid DID format/);
  });

  it('rejects a DID whose key part is not valid base58', async () => {
    const res = await PUT(signedRequest({ did: 'did:imajin:0OIl' }), params());
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toMatch(/Invalid DID format/);
  });

  it('rejects a signature made over a different timestamp', async () => {
    const res = await PUT(signedRequest({ signWith: String(Date.now() - 1000) }), params());
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toMatch(/Invalid signature/);
  });

  it('rejects a signature that cannot be verified at all', async () => {
    const res = await PUT(signedRequest({ signature: 'abcd' }), params());
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toMatch(/Signature verification failed/);
  });

  it('rejects when the signing DID is not the authenticated identity', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: OTHER_DID } });
    mockResolveActingDid.mockReturnValue(SIGNER_DID);
    const res = await PUT(signedRequest({}), params());
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatch(/does not match authenticated identity/);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('surfaces a throw from malformed signature hex as a 500, same as before the sync change', async () => {
    // A one-character signature makes `.match(/.{2}/g)` return null → TypeError.
    const res = await PUT(signedRequest({ signature: 'a' }), params());
    expect(res.status).toBe(500);
  });
});
