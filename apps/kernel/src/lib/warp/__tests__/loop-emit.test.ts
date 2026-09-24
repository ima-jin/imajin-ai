/**
 * Tests for `emitWarpRunLoopEvent` (#2296) — the kernel-node-witnessed
 * signing + ingest bridge that puts a Warp run transition onto the loop
 * registry rail. `getNodeSigningIdentity`, `ingestLoopEvent`, and the
 * `@imajin/auth` crypto primitives are all mocked, so these pin the exact
 * envelope/signature shape without touching a real database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getNodeSigningIdentityMock, ingestLoopEventMock, signSyncMock, canonicalizeMock, logMock } = vi.hoisted(
  () => ({
    getNodeSigningIdentityMock: vi.fn(),
    ingestLoopEventMock: vi.fn(),
    signSyncMock: vi.fn(),
    canonicalizeMock: vi.fn((value: unknown) => JSON.stringify(value)),
    logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }),
);

vi.mock('@imajin/logger', () => ({
  createLogger: () => logMock,
}));

vi.mock('@imajin/auth', () => ({
  canonicalize: canonicalizeMock,
  crypto: { signSync: signSyncMock },
}));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: getNodeSigningIdentityMock,
}));

vi.mock('@/src/lib/loops/ingest', () => ({
  ingestLoopEvent: ingestLoopEventMock,
}));

import { emitWarpRunLoopEvent, type WarpRunLoopTransition } from '../loop-emit';

const NODE_IDENTITY = {
  privateKeyHex: 'a'.repeat(64),
  senderPubkey: 'B'.repeat(64), // uppercase on purpose — the module must lowercase it
  senderDid: 'did:imajin:node-witness',
};

const TRANSITION: WarpRunLoopTransition = {
  type: 'loop.started',
  runId: 'run-123',
  principalDid: 'did:imajin:veteze',
  parentRunId: 'run-parent-1',
  state: 'queued',
  summary: 'Warp run dispatched (veteze-jin)',
  at: '2026-09-23T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  getNodeSigningIdentityMock.mockReturnValue(NODE_IDENTITY);
  signSyncMock.mockReturnValue('CAFE'.repeat(32)); // 128 hex chars, uppercase on purpose
  ingestLoopEventMock.mockResolvedValue({ ok: true });
});

describe('emitWarpRunLoopEvent', () => {
  it('ingests with publisherDid = the kernel node witness, never the dispatching DID', async () => {
    await emitWarpRunLoopEvent(TRANSITION);

    expect(ingestLoopEventMock).toHaveBeenCalledTimes(1);
    const [request] = ingestLoopEventMock.mock.calls[0] as [Record<string, unknown>];
    expect(request.publisherDid).toBe(NODE_IDENTITY.senderDid);
    expect(request.publisherDid).not.toBe(TRANSITION.principalDid);
  });

  it('builds the common loop envelope: loopId = runId, kind = warp.run, principal = onBehalfOf DID', async () => {
    await emitWarpRunLoopEvent(TRANSITION);

    const [request] = ingestLoopEventMock.mock.calls[0] as [{ type: string; payload: Record<string, unknown> }];
    expect(request.type).toBe('loop.started');
    expect(request.payload).toMatchObject({
      loopId: 'run-123',
      kind: 'warp.run',
      principal: 'did:imajin:veteze',
      parentLoopId: 'run-parent-1',
      refs: { runId: 'run-123' },
      state: 'queued',
      summary: 'Warp run dispatched (veteze-jin)',
      at: '2026-09-23T00:00:00.000Z',
    });
  });

  it('passes null parentLoopId through untouched when the transition carries no parent', async () => {
    await emitWarpRunLoopEvent({ ...TRANSITION, parentRunId: null });

    const [request] = ingestLoopEventMock.mock.calls[0] as [{ payload: Record<string, unknown> }];
    expect(request.payload.parentLoopId).toBeNull();
  });

  it('signs { type, payload } and lower-cases the hex keyId/sig, mirroring operator.approval.decided\u2019s witness posture', async () => {
    await emitWarpRunLoopEvent(TRANSITION);

    const [request] = ingestLoopEventMock.mock.calls[0] as [
      { type: string; payload: Record<string, unknown>; signature: Record<string, unknown> },
    ];
    expect(canonicalizeMock).toHaveBeenCalledWith({ type: request.type, payload: request.payload });
    expect(signSyncMock).toHaveBeenCalledWith(canonicalizeMock.mock.results[0]?.value, NODE_IDENTITY.privateKeyHex);
    expect(request.signature).toEqual({
      keyId: NODE_IDENTITY.senderPubkey.toLowerCase(),
      alg: 'ed25519',
      sig: 'cafe'.repeat(32),
    });
  });

  it('logs a warning (never throws) when ingestLoopEvent rejects the event', async () => {
    ingestLoopEventMock.mockResolvedValue({ ok: false, error: 'Invalid publisher signature', status: 400 });

    await expect(emitWarpRunLoopEvent(TRANSITION)).resolves.toBeUndefined();
    expect(logMock.warn).toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('never throws when getNodeSigningIdentity itself throws (e.g. AUTH_PRIVATE_KEY missing)', async () => {
    getNodeSigningIdentityMock.mockImplementation(() => {
      throw new Error('AUTH_PRIVATE_KEY is required in production');
    });

    await expect(emitWarpRunLoopEvent(TRANSITION)).resolves.toBeUndefined();
    expect(ingestLoopEventMock).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('never throws when ingestLoopEvent itself rejects', async () => {
    ingestLoopEventMock.mockRejectedValue(new Error('bus unavailable'));

    await expect(emitWarpRunLoopEvent(TRANSITION)).resolves.toBeUndefined();
    expect(logMock.error).toHaveBeenCalled();
  });
});
