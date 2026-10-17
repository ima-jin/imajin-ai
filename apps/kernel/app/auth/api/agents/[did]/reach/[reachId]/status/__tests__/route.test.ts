import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST } from '../route';
import { reachStatusTranscript, parseSignedReachStatus, authenticateSignedReachStatus } from '@/src/lib/auth/reach-status-auth';
import { FUTURE_TOLERANCE, SIGNED_MESSAGE_MAX_AGE } from '@imajin/auth';

const mocked = vi.hoisted(() => ({ resolve: vi.fn(), status: vi.fn() }));
vi.mock('@imajin/auth/resolve-db', () => ({ createDbResolver: () => mocked.resolve }));
vi.mock('@/src/db', () => ({ db: {}, identities: {} }));
vi.mock('@/src/lib/auth/reach-status', () => ({ reachStatus: mocked.status }));

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const principalDid = 'did:imajin:ryan';
const requesterDid = 'did:imajin:stranger';
const reachId = 'reach_1';
const reply = { type: 'agent.reach.replied', payload: { message: 'Reply', signature: { keyId: publicKey } } };

function body(issuedAt = new Date().toISOString()) {
  const fields = { requesterDid, issuedAt };
  return { ...fields, signature: sign(null, Buffer.from(reachStatusTranscript(principalDid, reachId, fields)), keys.privateKey).toString('hex') };
}

function request(raw: unknown = body(), targetReach = reachId) {
  return POST(new NextRequest(`https://node.test/auth/api/agents/${principalDid}/reach/${targetReach}/status`, {
    method: 'POST', body: JSON.stringify(raw),
  }), { params: Promise.resolve({ did: principalDid, reachId: targetReach }) });
}

beforeEach(() => {
  mocked.resolve.mockReset().mockResolvedValue({ publicKey });
  mocked.status.mockReset().mockResolvedValue({ reachId, state: 'replied', reply });
});

describe('signed reach_status route', () => {
  it('returns the same reachId and signed reply to its authenticated sender', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reachId, state: 'replied', reply });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocked.status).toHaveBeenCalledWith({ principalDid, requesterDid, reachId });
  });

  it('binds the signature to the exact reach id', async () => {
    expect((await request(body(), 'other')).status).toBe(401);
    expect(mocked.status).not.toHaveBeenCalled();
  });

  it('binds the signature to the sender, principal and operation', async () => {
    expect((await request({ ...body(), requesterDid: 'did:imajin:other' })).status).toBe(401);
    const signed = body();
    expect(await authenticateSignedReachStatus('did:imajin:other', reachId, signed)).toBe(false);
    expect(mocked.status).not.toHaveBeenCalled();
  });

  it.each([
    -SIGNED_MESSAGE_MAX_AGE - 1000,
    FUTURE_TOLERANCE + 1000,
  ])('rejects stale/future signatures', async (offset) => {
    expect((await request(body(new Date(Date.now() + offset).toISOString()))).status).toBe(401);
    expect(mocked.status).not.toHaveBeenCalled();
  });

  it('rejects unknown and rotated requester keys', async () => {
    mocked.resolve.mockResolvedValueOnce(null);
    expect((await request()).status).toBe(401);
    const rotated = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    mocked.resolve.mockResolvedValueOnce({ publicKey: rotated });
    expect((await request()).status).toBe(401);
    expect(mocked.status).not.toHaveBeenCalled();
  });

  it('returns the same not-found response for unknown or unrelated receipts', async () => {
    mocked.status.mockResolvedValue(null);
    expect((await request()).status).toBe(404);
  });

  it.each([null, [], {}, { ...body(), issuedAt: 'no' }, { ...body(), signature: 'bad' }, { ...body(), requesterDid: 'not-a-did' }])(
    'rejects malformed status input %j', async (raw) => {
      expect(parseSignedReachStatus(raw)).toBeNull();
      expect((await request(raw)).status).toBe(400);
    },
  );

  it('rejects non-JSON input and nonfinite timestamp verification', async () => {
    const response = await POST(new NextRequest('https://node.test/status', { method: 'POST', body: '{' }), {
      params: Promise.resolve({ did: principalDid, reachId }),
    });
    expect(response.status).toBe(400);
    expect(await authenticateSignedReachStatus(principalDid, reachId, { ...body(), issuedAt: 'invalid' })).toBe(false);
  });
});
