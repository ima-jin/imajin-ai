import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockVerify, mockAuthorize, mockPublish, logMock } = vi.hoisted(() => ({
  mockVerify: vi.fn(),
  mockAuthorize: vi.fn(),
  mockPublish: vi.fn(),
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => logMock,
}));

vi.mock('../verify-publisher-signature', () => ({
  verifyLoopPublisherSignature: mockVerify,
}));

vi.mock('../authorize-publisher', () => ({
  authorizeLoopPublisher: mockAuthorize,
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
  mockAuthorize.mockResolvedValue({ authorized: true });
});

describe('ingestLoopEvent', () => {
  it('rejects with 400 and never publishes when signature verification fails (forged/unsigned event)', async () => {
    mockVerify.mockResolvedValueOnce({ ok: false, error: 'Invalid publisher signature' });

    const result = await ingestLoopEvent(REQUEST);

    expect(result).toEqual({ ok: false, error: 'Invalid publisher signature', status: 400 });
    expect(mockAuthorize).not.toHaveBeenCalled();
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

  it('checks publisher authorization against publisherDid + payload.principal after a valid signature', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    mockPublish.mockResolvedValueOnce(undefined);

    await ingestLoopEvent(REQUEST);

    expect(mockAuthorize).toHaveBeenCalledWith(REQUEST.publisherDid, REQUEST.payload.principal);
  });

  it('rejects with 403 and never publishes when the publisher is not authorized for the principal (#2358)', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    mockAuthorize.mockResolvedValueOnce({ authorized: false, reason: 'publisherDid is not authorized to publish loop history for principal' });

    const result = await ingestLoopEvent(REQUEST);

    expect(result).toEqual({
      ok: false,
      error: 'publisherDid is not authorized to publish loop history for principal',
      status: 403,
      code: 'loop_publisher_unauthorized',
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('logs only the DID pair (never the envelope payload) on an authorization rejection', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    mockAuthorize.mockResolvedValueOnce({ authorized: false, reason: 'nope' });

    await ingestLoopEvent(REQUEST);

    const rejectionCall = logMock.warn.mock.calls.find(([, message]) => message === 'loop event publisher not authorized for principal');
    expect(rejectionCall?.[0]).toEqual({ publisherDid: REQUEST.publisherDid, principal: REQUEST.payload.principal });
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
