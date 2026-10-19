/**
 * Tests for POST /auth/api/knock (#1883) — public submission endpoint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crypto as authCrypto, SIGNED_MESSAGE_MAX_AGE, FUTURE_TOLERANCE } from '@imajin/auth';
import { knockReceiptTranscript } from '@/src/lib/auth/knock-receipt';

const { submitKnockMock, rateLimitMock, unsafeMock } = vi.hoisted(() => ({
  submitKnockMock: vi.fn(),
  rateLimitMock: vi.fn(),
  unsafeMock: vi.fn(),
}));
vi.mock('@imajin/db', () => ({ getClient: () => ({ unsafe: unsafeMock }) }));

vi.mock('@/src/lib/auth/knock', () => ({ submitKnock: submitKnockMock }));
vi.mock('@imajin/config', () => ({
  rateLimit: rateLimitMock,
  getClientIP: () => '203.0.113.1',
}));

import { POST } from '../route';

const ENDPOINT = 'http://localhost:3000/auth/api/knock';
type RouteRequest = Parameters<typeof POST>[0];

function makeRequest(body?: unknown): RouteRequest {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as RouteRequest;
}

const VALID_BODY = {
  publicKey: 'a'.repeat(64),
  declared_target: 'did:imajin:ryan',
  self_description: 'A matchmaking agent for professional intros.',
  requested_capabilities: ['intros:propose'],
};

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.mockReturnValue({ limited: false, retryAfter: 0 });
});

describe('POST /auth/api/knock', () => {
  const escrowKey = '55'.repeat(32);
  const key = authCrypto.getPublicKey(escrowKey);
  function receiptBody(issuedAt = new Date().toISOString()) {
    const input = { knockId: 'knock-private', issuedAt };
    return { action: 'receipt', ...input, signature: authCrypto.signSync(knockReceiptTranscript(input), escrowKey) };
  }
  function escrow() {
    unsafeMock.mockResolvedValueOnce([{ public_key: key, agent_did: 'agent', declared_target: 'principal' }]);
  }

  it('returns only the original receipt after private-key proof, without minting or submitting', async () => {
    escrow();
    const receipt = { payload: { mode: 'reply', replyMessage: 'Private reply' }, signature: 'node-signature', senderPubkey: 'node-key' };
    unsafeMock.mockResolvedValueOnce([{
      proposal_id: 'proposal', source: 'knock', kind: 'knock:request', summary: 'Incoming agent knock',
      keys_touched: [], detail: { knockId: 'knock-private', principalDid: 'principal', requesterDid: 'agent', claimVerified: false },
      decision: receipt,
    }]);
    const response = await POST(makeRequest(receiptBody()));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      receipt: { ...receipt, evidence: {
        proposalId: 'proposal', source: 'knock', kind: 'knock:request', summary: 'Incoming agent knock',
        keysTouched: [], detail: { knockId: 'knock-private', principalDid: 'principal', requesterDid: 'agent', claimVerified: false },
      } },
    });
    expect(submitKnockMock).not.toHaveBeenCalled();
    expect(unsafeMock.mock.calls[1][1]).toEqual(['principal', 'agent', 'knock-private']);
  });

  it('returns null for an authenticated pending receipt', async () => {
    escrow();
    unsafeMock.mockResolvedValueOnce([]);
    expect(await (await POST(makeRequest(receiptBody()))).json()).toEqual({ receipt: null });
    expect(submitKnockMock).not.toHaveBeenCalled();
  });

  it.each(['missing', 'wrong-key', 'tampered-id', 'tampered-time', 'unknown'])('rejects %s proof without revealing receipt content', async (mode) => {
    const input = receiptBody();
    if (mode === 'unknown') unsafeMock.mockResolvedValueOnce([]);
    else if (mode !== 'missing') escrow();
    if (mode === 'missing') input.signature = '';
    if (mode === 'wrong-key') input.signature = authCrypto.signSync(knockReceiptTranscript(input), '66'.repeat(32));
    if (mode === 'tampered-id') input.knockId = 'different-knock';
    if (mode === 'tampered-time') input.issuedAt = new Date(Date.now() - 1000).toISOString();
    const response = await POST(makeRequest({ ...input, publicKey: authCrypto.getPublicKey('66'.repeat(32)) }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid knock receipt proof' });
    expect(unsafeMock).toHaveBeenCalledTimes(mode === 'missing' ? 0 : 1);
    expect(submitKnockMock).not.toHaveBeenCalled();
  });

  it.each([-SIGNED_MESSAGE_MAX_AGE - 1000, FUTURE_TOLERANCE + 1000])('rejects out-of-window receipt signatures (%s)', async (offset) => {
    const response = await POST(makeRequest(receiptBody(new Date(Date.now() + offset).toISOString())));
    expect(response.status).toBe(401);
    expect(unsafeMock).not.toHaveBeenCalled();
  });
  it.each([
    { knockId: 'x'.repeat(201) }, { issuedAt: 'x'.repeat(65) }, { issuedAt: 'invalid' }, { signature: 'bad' },
  ])('bounds receipt fields before key lookup (%j)', async (change) => {
    const response = await POST(makeRequest({ ...receiptBody(), ...change }));
    expect(response.status).toBe(401);
    expect(unsafeMock).not.toHaveBeenCalled();
  });
  it('does not reveal storage errors in a receipt response', async () => {
    unsafeMock.mockRejectedValueOnce(new Error('private SQL details'));
    const response = await POST(makeRequest(receiptBody()));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Knock receipt unavailable' });
  });
  it('rejects when the per-IP rate limit is exceeded', async () => {
    rateLimitMock.mockReturnValueOnce({ limited: true, retryAfter: 30 });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(429);
    expect(submitKnockMock).not.toHaveBeenCalled();
  });

  it('rejects when the per-target rate limit is exceeded', async () => {
    rateLimitMock
      .mockReturnValueOnce({ limited: false, retryAfter: 0 }) // IP check
      .mockReturnValueOnce({ limited: true, retryAfter: 60 }); // target check

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(429);
    expect(submitKnockMock).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON', async () => {
    const res = await POST(new Request(ENDPOINT, { method: 'POST', body: '{not json' }) as unknown as RouteRequest);
    expect(res.status).toBe(400);
  });

  it('passes snake_case fields through to submitKnock', async () => {
    submitKnockMock.mockResolvedValue({ knock: { knockId: 'knock_1', status: 'pending' } });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(201);
    expect(submitKnockMock).toHaveBeenCalledWith({
      publicKey: VALID_BODY.publicKey,
      declaredTarget: VALID_BODY.declared_target,
      selfDescription: VALID_BODY.self_description,
      requestedCapabilities: VALID_BODY.requested_capabilities,
      externalDid: undefined,
    });
  });

  it('also accepts camelCase field aliases', async () => {
    submitKnockMock.mockResolvedValue({ knock: { knockId: 'knock_1', status: 'pending' } });

    const res = await POST(makeRequest({
      publicKey: VALID_BODY.publicKey,
      declaredTarget: VALID_BODY.declared_target,
      selfDescription: VALID_BODY.self_description,
      requestedCapabilities: VALID_BODY.requested_capabilities,
      externalDid: 'did:web:boardy.ai',
    }));

    expect(res.status).toBe(201);
    expect(submitKnockMock).toHaveBeenCalledWith(expect.objectContaining({
      declaredTarget: VALID_BODY.declared_target,
      externalDid: 'did:web:boardy.ai',
    }));
  });

  it('surfaces a lib-level validation error with its own status code', async () => {
    submitKnockMock.mockResolvedValue({ error: 'declared_target does not resolve to an existing principal', status: 404 });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(404);
  });
});
