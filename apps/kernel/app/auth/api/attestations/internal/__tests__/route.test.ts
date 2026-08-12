/**
 * Tests for POST /auth/api/attestations/internal — the `attestation.created`
 * bus emit added in #1820.
 *
 * This route previously never published `attestation.created` at all. It also
 * never accepts `author_jws`, so every attestation it creates must publish with
 * `pendingSignature: false` — that is what keeps the `attestation-notify`
 * reactor from firing for the many system attestations (identity, vouch,
 * ticket receipts, etc.) that flow through this route via `emitAttestation()`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const ISSUER = 'did:imajin:alice';
const SUBJECT = 'did:imajin:bob';
const API_KEY = 'internal-api-key';

const h = vi.hoisted(() => ({
  mockReturning: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/src/db', () => ({
  db: {
    insert: () => ({ values: () => ({ returning: h.mockReturning }) }),
  },
  attestations: {},
}));

vi.mock('@imajin/auth', () => ({
  canonicalize: (obj: unknown) => JSON.stringify(obj),
  crypto: { signSync: () => 'fake-signature' },
  ATTESTATION_TYPES: ['identity.created'],
  verifyNostrSig: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({ publish: h.mockPublish }));

import { POST } from '../route';

function makeReq(body: unknown, opts: { origin?: string; apiKey?: string } = {}): NextRequest {
  const headers = new Headers();
  headers.set('authorization', `Bearer ${opts.apiKey ?? API_KEY}`);
  if (opts.origin) headers.set('origin', opts.origin);
  return { headers, json: async () => body } as unknown as NextRequest;
}

function publishedPayload(): Record<string, unknown> {
  return h.mockPublish.mock.calls[0][1].payload as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ATTESTATION_INTERNAL_API_KEY = API_KEY;
  process.env.AUTH_PRIVATE_KEY = 'fake-private-key';
  h.mockReturning.mockResolvedValue([{ id: 'att_internal_123' }]);
  h.mockPublish.mockResolvedValue(undefined);
});

describe('attestation.created payload (internal route)', () => {
  it('publishes attestation.created after inserting the row', async () => {
    const res = await POST(
      makeReq({ issuer_did: ISSUER, subject_did: SUBJECT, type: 'identity.created' }),
    );

    expect(res.status).toBe(201);
    expect(h.mockPublish).toHaveBeenCalledTimes(1);
    expect(h.mockPublish.mock.calls[0][0]).toBe('attestation.created');
    expect(publishedPayload()).toMatchObject({
      attestationId: 'att_internal_123',
      type: 'identity.created',
      issuerDid: ISSUER,
      subjectDid: SUBJECT,
    });
  });

  it('always sets pendingSignature to false — this route never accepts author_jws', async () => {
    await POST(makeReq({ issuer_did: ISSUER, subject_did: SUBJECT, type: 'identity.created' }));

    expect(publishedPayload().pendingSignature).toBe(false);
  });

  it('derives originUrl from the Origin header when the caller is a browser-facing app', async () => {
    await POST(
      makeReq(
        { issuer_did: ISSUER, subject_did: SUBJECT, type: 'identity.created' },
        { origin: 'https://xprize.example.com' },
      ),
    );

    expect(publishedPayload().originUrl).toBe('https://xprize.example.com');
  });

  it('omits originUrl for a plain service-to-service call with no Origin header', async () => {
    await POST(makeReq({ issuer_did: ISSUER, subject_did: SUBJECT, type: 'identity.created' }));

    expect(publishedPayload().originUrl).toBeUndefined();
  });

  it('does not publish when the request is unauthorized', async () => {
    const res = await POST(
      makeReq(
        { issuer_did: ISSUER, subject_did: SUBJECT, type: 'identity.created' },
        { apiKey: 'wrong-key' },
      ),
    );

    expect(res.status).toBe(401);
    expect(h.mockPublish).not.toHaveBeenCalled();
  });
});
