import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEmit, mockSubscriber } = vi.hoisted(() => ({
  mockEmit: vi.fn().mockResolvedValue(undefined),
  mockSubscriber: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@imajin/db', () => ({ getClient: () => () => Promise.resolve([]) }));
vi.mock('@imajin/emit', () => ({ emit: mockEmit }));
vi.mock('../src/subscriptions', () => ({ deliverToSubscribers: mockSubscriber }));
vi.mock('../src/registry', async () => {
  const { emitReactor } = await import('../src/reactors/emit');
  return { getReactor: (type: string) => type === 'emit' ? emitReactor : undefined };
});

import { getChainConfig } from '../src/config';
import { publish } from '../src/publish';
import type { BusEventMap } from '../src/types';

const PRINCIPAL = 'did:imajin:principal';
const PAYLOAD: BusEventMap['agent.reach.replied'] = {
  reachId: 'reach_1', principalDid: PRINCIPAL, requesterDid: 'did:imajin:requester',
  transcriptHash: 'hash', message: 'PRIVATE MESSAGE', issuedAt: '2026-10-16T20:00:00.000Z',
  state: 'replied', context_id: 'reach_1', context_type: 'agent.reach',
  signature: { keyId: 'human-key', alg: 'ed25519', sig: 'PRIVATE SIGNATURE' },
};

beforeEach(() => vi.clearAllMocks());

describe('Reach reply bus contract', () => {
  it('emits metadata only while preserving the full signed reply for private subscriber delivery', async () => {
    await publish('agent.reach.replied', { issuer: PRINCIPAL, subject: PRINCIPAL, scope: 'agent', payload: PAYLOAD });
    expect(mockSubscriber).toHaveBeenCalledWith(expect.objectContaining({ payload: PAYLOAD }));
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const { message, signature, ...metadata } = PAYLOAD;
    expect(mockEmit.mock.calls[0][0].payload).toEqual(metadata);
    expect(JSON.stringify(mockEmit.mock.calls)).not.toContain(message);
    expect(JSON.stringify(mockEmit.mock.calls)).not.toContain(signature.sig);
  });

  it('seeds the identical metadata-only emit fallback and synchronizes agent overrides', async () => {
    const sql = readFileSync(new URL('../../../migrations/0197_seed_agent_reach_replied_chain.sql', import.meta.url), 'utf8');
    const literal = sql.match(/'(\[[^\n]+\])'::jsonb/)?.[1];
    expect(literal).toBeDefined();
    const config = await getChainConfig('agent.reach.replied', 'agent');
    expect(config.source).toBe('defaults');
    expect(JSON.parse(literal!)).toEqual(config.reactors);
    expect(config.reactors.map((reactor) => reactor.type)).toEqual(['emit']);
    expect(sql).toContain("WHERE event_type = 'agent.reach.replied' AND scope = 'agent'");
    expect(sql).toContain("WHERE event_type = 'agent.reach.replied' AND scope IS NULL");
    expect(sql).toContain('ON CONFLICT (event_type, scope) DO UPDATE');
  });
});
