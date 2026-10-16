import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import type { LoopIngestRequest, SurfaceEventType } from '../types';

const { nodeIdentity, project, publish, authorize } = vi.hoisted(() => ({
  nodeIdentity: vi.fn(), project: vi.fn(), publish: vi.fn(), authorize: vi.fn(),
}));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: nodeIdentity }));
vi.mock('@/src/db', () => ({ db: {}, identities: {} }));
vi.mock('../authorize-publisher', () => ({ authorizeLoopPublisher: authorize }));
vi.mock('../surface-lease', () => ({ projectSurfaceLease: project, loopObservationId: () => 'signed-finish' }));
vi.mock('@imajin/bus', () => ({ publish }));

import { ingestLoopEvent } from '../ingest';
import { parseLoopIngestRequest, isSurfaceUri } from '../types';
import { signSurfaceConflict } from '../surface-conflict';

function signed(type: SurfaceEventType = 'surface.acquired'): LoopIngestRequest {
  const identity = nodeIdentity();
  const payload = {
    loopId: 'loop-b', kind: 'review', principal: 'did:imajin:alice',
    state: 'running', summary: 'Working', at: new Date().toISOString(),
    surface: 'repo:ima-jin/imajin-ai#branch:main',
    ...(type === 'surface.conflicted' ? { refs: { conflictingLoopId: 'loop-a' } } : {}),
  };
  return {
    type, payload, publisherDid: identity.senderDid,
    signature: { keyId: identity.senderPubkey, alg: 'ed25519', sig: authCrypto.signSync(canonicalize({ type, payload }), identity.privateKeyHex) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const key = authCrypto.generateKeypair();
  nodeIdentity.mockReturnValue({ senderDid: 'did:imajin:node', senderPubkey: key.publicKey, privateKeyHex: key.privateKey });
  project.mockResolvedValue(null);
  authorize.mockResolvedValue({ authorized: true });
  publish.mockResolvedValue({});
});

describe('surface signed ingest contract', () => {
  it.each(['surface.acquired', 'surface.released', 'surface.conflicted'] as const)('parses and verifies %s without changing the signed payload', async (type) => {
    const request = signed(type);
    const parsed = parseLoopIngestRequest(request);
    expect(parsed).toEqual({ ok: true, value: request });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(await ingestLoopEvent(parsed.value)).toEqual({ ok: true });
    expect(project).toHaveBeenCalledWith(request);
    expect(publish).toHaveBeenCalledWith(type, expect.objectContaining({ issuer: request.publisherDid, subject: request.payload.principal, payload: request.payload }));
  });

  it('retries a failed acquisition publication and then emits the recovered conflict', async () => {
    const request = signed();
    project.mockResolvedValueOnce('loop-a').mockResolvedValueOnce('loop-a').mockResolvedValue(null);
    publish.mockRejectedValueOnce(new Error('bus unavailable')).mockResolvedValue({});
    expect(await ingestLoopEvent(request)).toMatchObject({ ok: false, status: 500 });
    expect(await ingestLoopEvent(request)).toEqual({ ok: true });
    expect(publish.mock.calls.map(([type]) => type)).toEqual(['surface.acquired', 'surface.acquired', 'surface.conflicted']);
  });

  it('passes a stable signed completion id so the bus reuses atomic completion history', async () => {
    const request = signed();
    const type = 'loop.finished';
    const identity = nodeIdentity();
    const finished: LoopIngestRequest = {
      ...request, type,
      signature: { ...request.signature, sig: authCrypto.signSync(canonicalize({ type, payload: request.payload }), identity.privateKeyHex) },
    };
    expect(await ingestLoopEvent(finished)).toEqual({ ok: true });
    expect(publish).toHaveBeenCalledWith(type, expect.objectContaining({ id: 'signed-finish' }));
  });

  it.each(['surface.acquired', 'surface.released', 'surface.conflicted'] as const)('rejects forged %s before any projection or publication', async (type) => {
    const request = signed(type);
    request.signature.sig = '0'.repeat(128);
    expect(await ingestLoopEvent(request)).toMatchObject({ ok: false, status: 400 });
    expect(authorize).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(['surface.acquired', 'surface.released', 'surface.conflicted'] as const)('rejects unauthorized %s before persistence', async (type) => {
    authorize.mockResolvedValue({ authorized: false });
    expect(await ingestLoopEvent(signed(type))).toMatchObject({ ok: false, status: 403 });
    expect(project).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('binds the surface URI and event kind into the signed message', async () => {
    const request = signed();
    request.payload.surface = 'issue:#1';
    expect(await ingestLoopEvent(request)).toMatchObject({ ok: false, status: 400 });
    const changedKind = { ...signed(), type: 'surface.released' as const };
    expect(await ingestLoopEvent(changedKind)).toMatchObject({ ok: false, status: 400 });
  });

  it('emits a node-signed conflict through real verification with both loop ids, never a denial', async () => {
    project.mockResolvedValueOnce('loop-a').mockResolvedValue(null);
    expect(await ingestLoopEvent(signed())).toEqual({ ok: true });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]).toEqual(['surface.conflicted', expect.objectContaining({
      issuer: 'did:imajin:node',
      payload: expect.objectContaining({ loopId: 'loop-b', refs: { conflictingLoopId: 'loop-a' } }),
    })]);
    const conflict = project.mock.calls[1][0] as LoopIngestRequest;
    expect(authCrypto.verifySync(conflict.signature.sig, canonicalize({ type: conflict.type, payload: conflict.payload }), nodeIdentity().senderPubkey)).toBe(true);
  });

  it('still succeeds if the advisory conflict cannot be signed', async () => {
    const request = signed();
    project.mockResolvedValueOnce('loop-a');
    nodeIdentity.mockReturnValueOnce(nodeIdentity()).mockImplementationOnce(() => { throw new Error('signer unavailable'); });
    expect(await ingestLoopEvent(request)).toEqual({ ok: true });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('still succeeds if a generated advisory conflict is rejected', async () => {
    project.mockResolvedValueOnce('loop-a');
    authorize.mockResolvedValueOnce({ authorized: true }).mockResolvedValueOnce({ authorized: false });
    expect(await ingestLoopEvent(signed())).toEqual({ ok: true });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('reports persistence errors instead of pretending an acquisition was recorded', async () => {
    project.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await ingestLoopEvent(signed())).toMatchObject({ ok: false, status: 500 });
    expect(publish).not.toHaveBeenCalled();
  });

  it('signs derived conflict evidence as the node, not as the claimant', () => {
    const request = signed();
    request.publisherDid = 'did:imajin:external-publisher';
    const conflict = signSurfaceConflict(request, 'loop-a');
    expect(conflict.publisherDid).toBe('did:imajin:node');
    expect(conflict.payload.principal).toBe(request.payload.principal);
    expect(parseLoopIngestRequest(conflict).ok).toBe(true);
  });

  it('requires a conflicting loop reference for an explicit conflict', () => {
    const request = signed('surface.conflicted');
    request.payload.refs = {};
    expect(parseLoopIngestRequest(request)).toMatchObject({ ok: false, error: expect.stringContaining('conflictingLoopId') });
  });
});

describe('typed surface URIs', () => {
  it.each(['repo:ima-jin/imajin-ai#branch:feat/2405-leases', 'service:kernel@env:prod', 'device:phone-1', 'issue:#2405'])('accepts %s', (surface) => {
    expect(isSurfaceUri(surface)).toBe(true);
  });
  it.each([null, 1, '', 'repo:owner/repo', 'repo:owner/repo#branch:', 'repo:owner/repo#branch:main extra', 'service:kernel', 'device:', 'issue:#0', 'issue:#-1', 'issue:#1.5', 'https://host', 'device:' + 'a'.repeat(2049)])('rejects malformed URI %#', (surface) => {
    expect(isSurfaceUri(surface)).toBe(false);
  });
});
