import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockVerify, mockAuthorize, mockPublish, mockSql, logMock } = vi.hoisted(() => ({
  mockVerify: vi.fn(),
  mockAuthorize: vi.fn(),
  mockPublish: vi.fn(),
  mockSql: vi.fn(),
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@imajin/db', () => ({ getClient: () => mockSql }));

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

vi.mock('../surface-lease', () => ({
  projectSurfaceLease: vi.fn().mockResolvedValue(null),
  loopObservationId: vi.fn().mockReturnValue('signed-finish'),
}));
vi.mock('../surface-conflict', () => ({ signSurfaceConflict: vi.fn() }));

import { ingestLoopEvent } from '../ingest';
import type { LoopIngestRequest } from '../types';
import { OUTPUTS } from './output-fixtures';
import { queuedStep } from './horizon-fixtures';
import { projectSurfaceLease } from '../surface-lease';

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
  mockSql.mockResolvedValue([{ loop_id: 'loop_abc123' }]);
});

describe('ingestLoopEvent', () => {
  const stepRequest = (): LoopIngestRequest => ({
    ...REQUEST, type: 'step.queued', publisherDid: queuedStep().issuer,
    payload: queuedStep().payload as LoopIngestRequest['payload'],
  });

  it('publishes signed steps with stable ids, exact publisher proofs and no surface or ownership mutations', async () => {
    mockVerify.mockResolvedValue({ ok: true });
    const request = stepRequest();
    expect(await ingestLoopEvent(request)).toEqual({ ok: true });
    expect(await ingestLoopEvent(request)).toEqual({ ok: true });
    expect(mockPublish.mock.calls[0]).toEqual(mockPublish.mock.calls[1]);
    expect(mockPublish.mock.calls[0]).toEqual(['step.queued', expect.objectContaining({
      id: 'signed-finish', issuer: request.publisherDid,
      payload: { ...request.payload, publisherProof: request },
    })]);
    expect(mockSql).not.toHaveBeenCalled();
    expect(projectSurfaceLease).not.toHaveBeenCalled();
  });

  it('rejects malformed direct-call step data before publishing or writing', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    const request = stepRequest();
    request.payload.zone = 'done';
    expect(await ingestLoopEvent(request)).toMatchObject({ status: 400 });
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('never retains a redaction-changing step fact as an unverifiable attestation', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    const request = stepRequest();
    request.payload.summary = 'Bearer private-value';
    expect(await ingestLoopEvent(request)).toMatchObject({ status: 400 });
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });
  it('rejects with 400 and never publishes when signature verification fails (forged/unsigned event)', async () => {
    mockVerify.mockResolvedValueOnce({ ok: false, error: 'Invalid publisher signature' });

    const result = await ingestLoopEvent(REQUEST);

    expect(result).toEqual({ ok: false, error: 'Invalid publisher signature', status: 400 });
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(logMock.warn).toHaveBeenCalledWith(
      { type: REQUEST.type, loopId: REQUEST.payload.loopId, publisherDid: REQUEST.publisherDid },
      'loop event signature rejected',
    );
  });

  it('redacts credential-shaped identifiers in signature rejection logs', async () => {
    mockVerify.mockResolvedValueOnce({ ok: false, error: 'Invalid publisher signature' });
    await ingestLoopEvent({
      ...REQUEST,
      publisherDid: 'did:imajin:sk-secretcredential',
      payload: { ...REQUEST.payload, loopId: 'loop:sk-secretcredential' },
    });
    expect(logMock.warn).toHaveBeenCalledWith(
      { type: REQUEST.type, loopId: 'loop:[REDACTED]', publisherDid: 'did:imajin:[REDACTED]' },
      'loop event signature rejected',
    );
  });

  it('omits caller proof metadata when redaction prevents an exact server proof', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    const payload = { ...REQUEST.payload, summary: 'Bearer original-secret', publisherProof: { forged: true } };
    expect(await ingestLoopEvent({ ...REQUEST, payload })).toEqual({ ok: true });
    expect(mockPublish.mock.calls[0][1].payload).not.toHaveProperty('publisherProof');
  });

  it('does not duplicate oversized unredacted output inside a proof', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    const payload = { ...REQUEST.payload, output: { kind: 'text' as const, text: 'x'.repeat(20000) } };
    expect(await ingestLoopEvent({ ...REQUEST, payload })).toEqual({ ok: true });
    expect(mockPublish.mock.calls[0][1].payload).not.toHaveProperty('publisherProof');
  });

  it('rejects a redaction-changing publisher without changing issuer identity', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    expect(await ingestLoopEvent({ ...REQUEST, publisherDid: 'did:imajin:sk-secretcredential' }))
      .toMatchObject({ status: 400 });
    expect(mockSql).not.toHaveBeenCalled();
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
      payload: { ...REQUEST.payload, publisherProof: REQUEST },
      correlationId: 'loop_abc123',
    });
  });

  it('preserves the exact signed payload without mutating it or trusting caller proof metadata', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    mockPublish.mockResolvedValueOnce(undefined);
    const request = { ...REQUEST, payload: { ...REQUEST.payload, publisherProof: 'untrusted' } };
    const before = JSON.stringify(request);
    await ingestLoopEvent(request);
    const published = mockPublish.mock.calls[0][1].payload;
    expect(published.publisherProof).toEqual(request);
    expect(published.publisherProof.payload.publisherProof).toBe('untrusted');
    expect(JSON.stringify(request)).toBe(before);
  });

  it('reports a 500 when publish itself throws', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    mockPublish.mockRejectedValueOnce(new Error('bus unavailable'));

    const result = await ingestLoopEvent(REQUEST);

    expect(result).toEqual({ ok: false, error: 'Failed to publish loop event', status: 500 });
  });

  it.each(OUTPUTS)('ingests $kind without discarding nested JSON', async output => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    const payload = { ...REQUEST.payload, output };
    expect(await ingestLoopEvent({ ...REQUEST, payload })).toEqual({ ok: true });
    expect(mockVerify).toHaveBeenCalledWith(REQUEST.publisherDid, { type: REQUEST.type, payload }, REQUEST.signature);
    expect(mockPublish.mock.calls[0][1].payload.output).toEqual(output);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('redacts the entire persisted envelope only after verifying the signed original', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    const payload = {
      ...REQUEST.payload,
      summary: 'Bearer original-secret',
      refs: { sessionId: 'postgres://user:pass@host/db' },
      metadata: { api_key: 'nested-secret' },
      output: { kind: 'tool_result' as const, callId: '1', result: { newField: [{ accessToken: 'secret', value: 'retained' }] } },
    };
    expect(await ingestLoopEvent({ ...REQUEST, payload })).toEqual({ ok: true });
    expect(mockVerify.mock.calls[0][1].payload).toBe(payload);
    expect(payload.summary).toBe('Bearer original-secret');
    const persisted = mockPublish.mock.calls[0][1].payload;
    expect(persisted.summary).toBe('Bearer [REDACTED]');
    expect(persisted.refs.sessionId).toBe('postgres://[REDACTED]@host/db');
    expect(persisted.metadata.api_key).toBe('[REDACTED]');
    expect(persisted.output.result.newField[0]).toEqual({ accessToken: '[REDACTED]', value: 'retained' });
    expect(persisted).not.toHaveProperty('publisherProof');
    expect(JSON.stringify(persisted)).not.toContain('original-secret');
    expect(JSON.stringify(mockSql.mock.calls)).not.toContain('nested-secret');
  });

  it('spills redacted UTF8 output above 16KiB and publishes only the server wrapper', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    const output = { kind: 'text' as const, text: `Bearer original-secret ${'界'.repeat(6000)}` };
    expect(await ingestLoopEvent({ ...REQUEST, payload: { ...REQUEST.payload, output } })).toEqual({ ok: true });
    expect(mockSql).toHaveBeenCalledTimes(2);
    const stored = mockPublish.mock.calls[0][1].payload.output;
    expect(stored).toMatchObject({ kind: 'text', truncated: true, artifactRef: { mediaType: 'application/json' } });
    expect(stored.artifactRef.byteLength).toBeGreaterThan(16384);
    expect(stored.preview.length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(mockSql.mock.calls)).not.toContain('original-secret');
    expect(mockPublish.mock.calls[0][1].payload).not.toHaveProperty('publisherProof');
  });

  it('fails ownership conflicts before artifact writes and publish', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    mockSql.mockResolvedValueOnce([]);
    const output = { kind: 'text' as const, text: 'x'.repeat(20000) };
    expect(await ingestLoopEvent({ ...REQUEST, payload: { ...REQUEST.payload, output } })).toMatchObject({ status: 409, code: 'loop_owner_conflict' });
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('fails artifact storage closed without logging driver errors or publishing', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    mockSql.mockResolvedValueOnce([{ loop_id: 'loop_abc123' }]).mockRejectedValueOnce(new Error('raw secret payload'));
    const output = { kind: 'text' as const, text: 'x'.repeat(20000) };
    expect(await ingestLoopEvent({ ...REQUEST, payload: { ...REQUEST.payload, output } })).toMatchObject({ status: 500 });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(JSON.stringify(logMock.error.mock.calls)).not.toContain('raw secret payload');
  });

  it('maps a reactor ownership conflict to 409', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    mockPublish.mockRejectedValueOnce({ code: 'loop_owner_conflict' });
    expect(await ingestLoopEvent(REQUEST)).toMatchObject({ status: 409 });
  });

  it('rejects publisher storage wrappers even for direct callers', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    const output = { kind: 'text', artifactRef: { id: 'forged' }, preview: 'text', truncated: true };
    expect(await ingestLoopEvent({ ...REQUEST, payload: { ...REQUEST.payload, output } } as unknown as LoopIngestRequest)).toMatchObject({ status: 400 });
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it.each(['loopId', 'principal', 'parentLoopId'])('rejects redaction-changing identity %s before ownership writes', async field => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    const payload = { ...REQUEST.payload, [field]: 'did:imajin:sk-secretcredential' };
    expect(await ingestLoopEvent({ ...REQUEST, payload })).toMatchObject({ status: 400 });
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('enforces metadata budget after redaction expansion', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    const metadata = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`token${index}`, '']));
    const payload = { ...REQUEST.payload, metadata };
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThan(16384);
    expect(await ingestLoopEvent({ ...REQUEST, payload })).toMatchObject({ status: 400 });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('enforces metadata budget for direct ingest callers', async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    expect(await ingestLoopEvent({ ...REQUEST, payload: { ...REQUEST.payload, metadata: 'x'.repeat(16384) } })).toMatchObject({ status: 400 });
    expect(mockSql).not.toHaveBeenCalled();
  });
});
