import { beforeEach, describe, expect, it, vi } from 'vitest';

const { emitAttestation, audit } = vi.hoisted(() => ({
  emitAttestation: vi.fn(), audit: vi.fn(),
}));
vi.mock('@imajin/auth', () => ({ emitAttestation }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() }),
}));
vi.mock('@imajin/db', () => ({ getClient: () => async () => [] }));
vi.mock('../src/subscriptions', () => ({ deliverToSubscribers: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/registry', async () => {
  const { attestationReactor } = await import('../src/reactors/attestation');
  return { getReactor: (type: string) => type === 'attestation' ? attestationReactor : audit };
});

import { publish } from '../src/publish';
import { getChainConfig } from '../src/config';

beforeEach(() => {
  vi.clearAllMocks();
  emitAttestation.mockResolvedValue({ attestationId: 'att_google_read' });
  audit.mockResolvedValue(undefined);
});

describe('Google read signed audit chain', () => {
  it('awaits signing then persists only owner/slot operation provenance', async () => {
    const ownerDid = 'did:imajin:organization';
    const payload = {
      ownerDid, onBehalfOf: ownerDid, slot: 'work', operation: 'business-profile.reviews.list',
      context_id: ownerDid, context_type: 'google' as const,
    };
    const result = await publish('google.data.read', {
      issuer: ownerDid, subject: ownerDid, scope: 'google', payload,
    });
    expect(result).toEqual({ attestationId: 'att_google_read' });
    expect(emitAttestation).toHaveBeenCalledWith({
      issuer_did: ownerDid, subject_did: ownerDid, type: 'google.data.read',
      context_id: ownerDid, context_type: 'google', payload, pending: false, originUrl: undefined,
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      payload: { ...payload, attestationId: 'att_google_read' },
    }), {});
    expect(emitAttestation.mock.invocationCallOrder[0]).toBeLessThan(audit.mock.invocationCallOrder[0]);
    const chain = await getChainConfig('google.data.read', 'google');
    expect(chain.reactors.map(({ type, await: awaited }) => [type, awaited]))
      .toEqual([['attestation', true], ['audit-log', true]]);
  });
});
