import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST } from '../route';
import { reachStatusTranscript, parseSignedReachStatus, authenticateSignedReachStatus } from '@/src/lib/auth/reach-status-auth';
import { FUTURE_TOLERANCE, SIGNED_MESSAGE_MAX_AGE } from '@imajin/auth';

const mocked = vi.hoisted(() => ({ resolve: vi.fn(), status: vi.fn(), bearer: vi.fn() }));
vi.mock('@/src/lib/auth/reach-authority', () => ({ resolveReachRequester: mocked.resolve }));
vi.mock('@/src/lib/auth/reach-status', () => ({ reachStatus: mocked.status }));
vi.mock('@/src/lib/access/reach-bearer', () => ({ resolveReachBearer: mocked.bearer }));

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
  mocked.bearer.mockReset().mockResolvedValue({ requesterDid: 'did:imajin:foreign_static' });
});

describe('HTTP reach bearer status', () => {
  async function poll(authorization = 'Bearer synthetic', raw?: unknown) {
    return POST(new NextRequest('https://node.test/status', {
      method: 'POST', headers: { authorization }, ...(raw === undefined ? {} : { body: JSON.stringify(raw) }),
    }), { params: Promise.resolve({ did: principalDid, reachId }) });
  }
  it('needs no signature or body and uses only the authenticated stub for receipt ownership', async () => {
    const response = await poll();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reachId, state: 'replied', reply });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocked.bearer).toHaveBeenCalledWith('synthetic', principalDid, 'status');
    expect(mocked.status).toHaveBeenCalledWith({ principalDid, reachId, requesterDid: 'did:imajin:foreign_static' });
    expect(mocked.resolve).not.toHaveBeenCalled();
  });
  it('ignores a body attempting to impersonate another requester', async () => {
    await poll('Bearer synthetic', body());
    expect(mocked.status).toHaveBeenCalledWith({ principalDid, reachId, requesterDid: 'did:imajin:foreign_static' });
    expect(mocked.resolve).not.toHaveBeenCalled();
  });
  it('does not fall back to signatures for a revoked or foreign-audience bearer', async () => {
    mocked.bearer.mockResolvedValue(null);
    expect((await poll('Bearer invalid', body())).status).toBe(401);
    expect(mocked.status).not.toHaveBeenCalled();
    expect(mocked.resolve).not.toHaveBeenCalled();
  });
  it('rejects unsupported authorization without resolving a credential', async () => {
    expect((await poll('Basic synthetic')).status).toBe(401);
    expect(mocked.bearer).not.toHaveBeenCalled();
    expect(mocked.status).not.toHaveBeenCalled();
  });
  it('returns 404 for another requester’s receipt', async () => {
    mocked.status.mockResolvedValue(null);
    const response = await poll();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Reach not found' });
  });
  it('reports blocked state without reply content for an otherwise-valid blocked sender', async () => {
    mocked.status.mockResolvedValue({ reachId, state: 'blocked', reply: null });
    expect(await (await poll()).json()).toEqual({ reachId, state: 'blocked', reply: null });
  });
});

describe('signed reach_status route', () => {
  it('returns the shared signed decision proof without dropping evidence or reply text', async () => {
    const receipt = {
      reachId, state: 'replied', reply: null,
      approvalDecision: {
        payload: { mode: 'reply', replyMessage: 'Shared reply', decidedBy: principalDid, operatorSignature: { sig: 'actor-proof' } },
        evidence: { detail: { principalDid, requesterDid, transcriptHash: 'transcript', claimVerified: false } },
      },
    };
    mocked.status.mockResolvedValue(receipt);
    expect(await (await request()).json()).toEqual(receipt);
  });
  it('rejects oversized signed status input before signature or receipt resolution', async () => {
    const response = await request({ ...body(), padding: 'x'.repeat(64 * 1024) });
    expect(response.status).toBe(413);
    expect(mocked.resolve).not.toHaveBeenCalled();
    expect(mocked.status).not.toHaveBeenCalled();
  });
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
  it('passes the supplied key to reach resolution and binds its exact value in the signature', async () => {
    const fields = { requesterDid: 'did:web:agent.example', publicKey, issuedAt: new Date().toISOString() };
    const signed = {
      ...fields,
      signature: sign(null, Buffer.from(reachStatusTranscript(principalDid, reachId, fields)), keys.privateKey).toString('hex'),
    };
    expect((await request(signed)).status).toBe(200);
    expect(mocked.resolve).toHaveBeenCalledWith(fields.requesterDid, publicKey);
    mocked.status.mockClear();
    // Same Ed25519 key bytes: rejection proves the field itself was signed.
    expect((await request({ ...signed, publicKey: publicKey.toUpperCase() })).status).toBe(401);
    const { publicKey: omitted, ...withoutKey } = signed;
    expect(omitted).toBe(publicKey);
    expect((await request(withoutKey)).status).toBe(401);
    expect((await request({ ...body(), publicKey })).status).toBe(401);
    expect(mocked.status).not.toHaveBeenCalled();
  });

  it.each([null, 123, '', 'bad', 'g'.repeat(64)])('rejects a malformed optional publicKey: %j', async (publicKey) => {
    expect((await request({ ...body(), publicKey })).status).toBe(400);
    expect(mocked.resolve).not.toHaveBeenCalled();
    expect(mocked.status).not.toHaveBeenCalled();
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
