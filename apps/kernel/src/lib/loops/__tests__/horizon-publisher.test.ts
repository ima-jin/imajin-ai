import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import type { LoopEventJson } from '../serialize';
import type { LoopIngestRequest } from '../types';

const { registry, history, authorize } = vi.hoisted(() => ({
  registry: new Map<string, { publicKey: string }>(),
  history: [] as LoopEventJson[],
  authorize: vi.fn(),
}));
vi.mock('@imajin/auth/resolve-db', () => ({
  createDbResolver: () => async (did: string) => registry.get(did),
}));
vi.mock('@/src/db', () => ({ db: {}, identities: {} }));
vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({ senderDid: 'did:imajin:node' }),
}));
vi.mock('../authorize-publisher', () => ({ authorizeLoopPublisher: authorize }));
vi.mock('@imajin/bus', () => ({
  publish: vi.fn(async (type: string, event: { id: string; issuer: string; payload: LoopIngestRequest['payload'] }) => {
    history.push({
      ...event, type, loopId: event.payload.loopId, principal: event.payload.principal,
      occurredAt: event.payload.at, createdAt: event.payload.at,
    });
  }),
}));

import { ingestLoopEvent } from '../ingest';
import { projectHorizon } from '../horizon';
import { CODE_STEP, STEP_ISSUE_UPDATE, STEP_PRINCIPAL } from './horizon-fixtures';

function publisher() {
  const key = authCrypto.generateKeypair();
  const did = authCrypto.createDID(key.publicKey);
  registry.set(did, { publicKey: key.publicKey });
  return { did, key };
}
function signed(
  signer: ReturnType<typeof publisher>, type: LoopIngestRequest['type'], sequence: number,
  stepId: string, fields: Record<string, unknown> = {},
): LoopIngestRequest {
  const payload = {
    loopId: 'cycle', kind: 'cycle', principal: STEP_PRINCIPAL, state: 'queued',
    summary: type, at: new Date(Date.now() - 10_000 + sequence * 1000).toISOString(), stepId, ...fields,
  };
  return {
    type, payload, publisherDid: signer.did,
    signature: { alg: 'ed25519', keyId: signer.key.publicKey,
      sig: authCrypto.signSync(canonicalize({ type, payload }), signer.key.privateKey) },
  };
}
const project = () => projectHorizon(history, 'cycle', STEP_PRINCIPAL);

beforeEach(() => {
  history.length = 0;
  registry.clear();
  authorize.mockReset().mockResolvedValue({ authorized: true });
});

describe('two-DID signed horizon contract (no plugin)', () => {
  it('projects both registered publishers, retaining but ignoring cross-publisher rewrites', async () => {
    const a = publisher();
    const b = publisher();
    expect(a.did).not.toBe(b.did);
    for (const [signer, id] of [[a, 'a'], [b, 'b']] as const) {
      expect(await ingestLoopEvent(signed(signer, 'step.queued', 0, id, { step: CODE_STEP }))).toEqual({ ok: true });
      expect(await ingestLoopEvent(signed(signer, 'step.updated', 1, id, { update: STEP_ISSUE_UPDATE }))).toEqual({ ok: true });
    }
    const baseline = project();
    expect(baseline.steps.map(step => [step.stepId, step.publisher])).toEqual([['a', a.did], ['b', b.did]]);
    for (const [signer, target] of [[b, 'a'], [a, 'b']] as const) {
      expect(await ingestLoopEvent(signed(signer, 'step.updated', 2, target, {
        publisher: signer.did, update: { rank: -99, intention: 'Replace another publisher’s step' },
      }))).toEqual({ ok: true });
      expect(await ingestLoopEvent(signed(signer, 'step.finished', 3, target))).toEqual({ ok: true });
    }
    expect(project()).toEqual(baseline);
    expect(history).toHaveLength(8);
    expect(history[4].issuer).toBe(b.did);
    expect(history[4].payload.publisherProof).toMatchObject({ publisherDid: b.did });
    const restored = structuredClone(history).reverse();
    expect(projectHorizon(restored, 'cycle', STEP_PRINCIPAL)).toEqual(baseline);
    expect(await ingestLoopEvent(signed(b, 'step.finished', 4, 'b'))).toEqual({ ok: true });
    expect(project().steps[1]).toMatchObject({ publisher: b.did, state: 'finished' });
  });

  it('rejects another key impersonating the publisher before history is appended', async () => {
    const a = publisher();
    const b = publisher();
    const request = signed(b, 'step.queued', 0, 'forged', { step: CODE_STEP });
    expect(await ingestLoopEvent({ ...request, publisherDid: a.did })).toMatchObject({ ok: false, status: 400 });
    expect(history).toHaveLength(0);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('still requires live principal-level authority for a second publisher', async () => {
    const b = publisher();
    authorize.mockResolvedValue({ authorized: false });
    expect(await ingestLoopEvent(signed(b, 'step.queued', 0, 'denied', { step: CODE_STEP })))
      .toMatchObject({ ok: false, status: 403 });
    expect(history).toHaveLength(0);
  });
});
