import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockVerify, mockPublish } = vi.hoisted(() => ({
  mockVerify: vi.fn(),
  mockPublish: vi.fn(),
}));

vi.mock('../verify-publisher-signature', () => ({
  verifyLoopPublisherSignature: mockVerify,
}));

vi.mock('@imajin/bus', () => ({
  publish: mockPublish,
}));

import { ingestLoopEvent } from '../ingest';
import type { LoopIngestRequest } from '../types';

const REQUEST: LoopIngestRequest = {
  type: 'loop.started',
  payload: {
    loopId: 'loop_abc123',
    kind: 'warp.run',
    principal: 'did:imajin:ryan',
    parentLoopId: null,
    state: 'queued',
    summary: 'Kicked off',
    at: '2026-09-22T00:00:00.000Z',
  },
  publisherDid: 'did:imajin:warp-node',
  signature: { keyId: 'a'.repeat(64), alg: 'ed25519', sig: 'b'.repeat(128) },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ingestLoopEvent', () => {
  it('rejects with 400 and never publishes when signature verification fails (forged/unsigned event)', async () => {
    mockVerify.mockResolvedValueOnce({ ok: false, error: 'Invalid publisher signature' });

    const result = await ingestLoopEvent(REQUEST);

    expect(result).toEqual({ ok: false, error: 'Invalid publisher signature', status: 400 });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('verifies over { type, payload } before publishing', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    mockPublish.mockResolvedValueOnce(undefined);

    await ingestLoopEvent(REQUEST);

    expect(mockVerify).toHaveBeenCalledWith(
      REQUEST.publisherDid,
      { type: REQUEST.type, payload: REQUEST.payload },
      REQUEST.signature,
    );
  });

  it('publishes the verified envelope with issuer=publisherDid, subject=principal, correlationId=loopId', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    mockPublish.mockResolvedValueOnce(undefined);

    const result = await ingestLoopEvent(REQUEST);

    expect(result).toEqual({ ok: true });
    expect(mockPublish).toHaveBeenCalledWith('loop.started', {
      issuer: 'did:imajin:warp-node',
      subject: 'did:imajin:ryan',
      scope: 'loop',
      payload: REQUEST.payload,
      correlationId: 'loop_abc123',
    });
  });

  it('reports a 500 when publish itself throws', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    mockPublish.mockRejectedValueOnce(new Error('bus unavailable'));

    const result = await ingestLoopEvent(REQUEST);

    expect(result).toEqual({ ok: false, error: 'Failed to publish loop event', status: 500 });
  });
});
