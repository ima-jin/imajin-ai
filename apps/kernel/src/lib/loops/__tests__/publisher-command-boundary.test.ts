import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalize, crypto } from '@imajin/auth';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(), authorize: vi.fn(), sql: vi.fn(), publish: vi.fn(),
  readProof: vi.fn(), resolver: vi.fn(), service: vi.fn(),
}));
vi.mock('@imajin/db', () => ({ getClient: () => mocks.sql }));
vi.mock('@/src/db', () => ({ db: {}, identities: {} }));
vi.mock('@imajin/auth/resolve-db', () => ({ createDbResolver: () => mocks.resolver }));
vi.mock('@/src/lib/auth/agent-service', () => ({ listServiceOf: mocks.service }));
vi.mock('../../jin/session-command-store', () => ({ readLoopCommandProof: mocks.readProof }));
vi.mock('../verify-publisher-signature', () => ({ verifyLoopPublisherSignature: mocks.verify }));
vi.mock('../authorize-publisher', () => ({ authorizeLoopPublisher: mocks.authorize }));
vi.mock('@imajin/bus', () => ({ publish: mocks.publish }));
vi.mock('../surface-lease', () => ({
  projectSurfaceLease: vi.fn().mockResolvedValue(null),
  loopObservationId: () => 'signed-origin',
}));
import { ingestLoopEvent } from '../ingest';
import { resolveSessionCommandTarget } from '../../jin/session-command-authority';
import type { LoopIngestRequest } from '../types';

const agent = 'did:imajin:agent';
const key = crypto.generateKeypair();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sql.mockResolvedValue([{ loop_id: 'loop' }]);
  mocks.authorize.mockResolvedValue({ authorized: true });
  mocks.resolver.mockResolvedValue({ publicKey: key.publicKey });
  mocks.service.mockResolvedValue(['did:imajin:personal', 'did:imajin:org']);
  mocks.verify.mockImplementation(async (_did, wire, signature) => ({
    ok: crypto.verifySync(signature.sig, canonicalize(wire), key.publicKey),
    error: 'Invalid signature',
  }));
});

function originRequest(principal: string, refs: Record<string, string>): LoopIngestRequest {
  const payload = {
    loopId: 'loop', kind: 'openclaw.session', principal, parentLoopId: null,
    state: 'running', summary: 'Started', at: new Date().toISOString(), refs,
  };
  return {
    type: 'loop.started', payload, publisherDid: agent,
    signature: {
      alg: 'ed25519', keyId: key.publicKey,
      sig: crypto.signSync(canonicalize({ type: 'loop.started', payload }), key.privateKey),
    },
  };
}

async function ingestOrigin(principal: string, refs: Record<string, string>) {
  const request = originRequest(principal, refs);
  expect(await ingestLoopEvent(request)).toEqual({ ok: true });
  const published = mocks.publish.mock.calls[0][1].payload;
  mocks.readProof.mockResolvedValue({
    loop: { state: 'running', parent_loop_id: null },
    proofs: [{ type: request.type, issuer: agent, proof: published.publisherProof }],
  });
  return published;
}

describe('signed publisher origin / native command boundary', () => {
  it.each(['did:imajin:personal', 'did:imajin:org'])(
    'preserves an exact clean origin for command authority under %s',
    async principal => {
      const published = await ingestOrigin(principal, { runId: 'run' });
      expect(published.publisherProof).toBeDefined();
      expect(await resolveSessionCommandTarget('loop', principal)).toBe(agent);
      published.publisherProof.payload.principal = 'did:imajin:foreign';
      await expect(resolveSessionCommandTarget('loop', principal)).rejects.toThrow('stale or invalid');
    },
  );

  it('rejects a legacy-addressed signed origin and keeps native authority closed until the publisher is updated', async () => {
    const principal = 'did:imajin:personal';
    const request = originRequest(principal, { runId: 'run', sessionKey: 'harness-only' });
    expect(await ingestLoopEvent(request)).toMatchObject({ status: 400 });
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
    mocks.readProof.mockResolvedValue({
      loop: { state: 'running', parent_loop_id: null },
      proofs: [{ type: request.type, issuer: agent, proof: undefined }],
    });
    await expect(resolveSessionCommandTarget('loop', principal)).rejects.toThrow('stale or invalid');
  });
});
