import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend, mockEmit, mockAttestation } = vi.hoisted(() => ({
  mockSend: vi.fn().mockResolvedValue(undefined),
  mockEmit: vi.fn().mockResolvedValue(undefined),
  mockAttestation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/db', () => ({ getClient: () => () => Promise.resolve([]) }));
vi.mock('@imajin/notify', () => ({ send: mockSend, interest: vi.fn() }));
vi.mock('@imajin/emit', () => ({ emit: mockEmit }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../src/registry', async () => {
  const { notifyReactor } = await import('../src/reactors/notify');
  const { emitReactor } = await import('../src/reactors/emit');
  return {
    getReactor: (type: string) => ({
      emit: emitReactor,
      notify: notifyReactor,
      attestation: mockAttestation,
    })[type],
  };
});

import { getChainConfig } from '../src/config';
import { publish } from '../src/publish';
import type { BusEventMap } from '../src/types';

const PRINCIPAL = 'did:imajin:principal';
const REQUESTER = 'did:imajin:requester';
const NODE = 'did:imajin:node';
const PAYLOAD: BusEventMap['agent.reach.delivered'] = {
  reachId: 'reach_example',
  principalDid: PRINCIPAL,
  requesterDid: REQUESTER,
  onBehalfOfStubDid: 'did:imajin:stub',
  onBehalfOf: { platform: 'foreign', externalRef: 'opaque-ref', selfDescription: 'Unverified claim' },
  topic: 'collaboration',
  message: 'PRIVATE MESSAGE NEVER SHOWN ON LOCKSCREEN',
  replyHandle: 'opaque-reply-handle',
  transcriptHash: 'transcript-hash',
  requesterSignature: 'request-signature',
  requesterTier: 'soft',
  grantId: 'grant_example',
  issuedAt: '2026-10-16T20:00:01.000Z',
  requestIssuedAt: '2026-10-16T20:00:00.000Z',
  source: 'reach',
  claimVerified: false,
  context_id: 'reach_example',
  context_type: 'agent.reach',
  url: '/jin?lane=inbox&reachId=reach_example',
  signature: { keyId: 'node-public-key', alg: 'ed25519', sig: 'node-signature' },
};

beforeEach(() => vi.clearAllMocks());

describe('Reach delivery chain (#2588)', () => {
  it.each([null, 'grant_example'])('publishes only allowlisted metadata to emit with grantId %s, never creating a second attestation', async (grantId) => {
    const payload = { ...PAYLOAD, grantId };
    await publish('agent.reach.delivered', {
      issuer: NODE, subject: PRINCIPAL, scope: 'agent', payload,
    });
    await Promise.resolve();

    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0]).toMatchObject({
      action: 'agent.reach.delivered', did: NODE, service: 'agent',
    });
    const emittedPayload = mockEmit.mock.calls[0][0].payload;
    expect(emittedPayload).toEqual({
      reachId: PAYLOAD.reachId,
      principalDid: PRINCIPAL,
      requesterDid: REQUESTER,
      topic: PAYLOAD.topic,
      requesterTier: PAYLOAD.requesterTier,
      transcriptHash: PAYLOAD.transcriptHash,
      issuedAt: PAYLOAD.issuedAt,
    });
    for (const key of ['message', 'replyHandle', 'requesterSignature']) {
      expect(emittedPayload).not.toHaveProperty(key);
    }
    expect(mockAttestation).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({
      to: PRINCIPAL,
      scope: 'agent.reach.delivered',
      title: 'New Reach message',
      body: `Reach message about collaboration from ${REQUESTER}`,
      data: {
        ...payload,
        eventType: 'agent.reach.delivered',
        issuer: NODE,
        subject: PRINCIPAL,
        correlationId: undefined,
        template: undefined,
      },
    });
    const notification = mockSend.mock.calls[0][0];
    expect(notification.body).not.toContain(PAYLOAD.message);
    expect(notification.body).not.toContain(PAYLOAD.replyHandle);
    expect(notification.body).not.toContain(PAYLOAD.onBehalfOf.selfDescription);
  });

  it('keeps actual SQL-seeded reactors identical to fallback DEFAULTS', async () => {
    const sql = readFileSync(new URL('../../../migrations/0196_seed_agent_reach_delivered_chain.sql', import.meta.url), 'utf8');
    const literal = sql.match(/'(\[[^\n]+\])'::jsonb/)?.[1];
    expect(literal).toBeDefined();
    const cfg = await getChainConfig('agent.reach.delivered', 'agent');
    expect(cfg.source).toBe('defaults');
    expect(JSON.parse(literal!)).toEqual(cfg.reactors);
    expect(cfg.reactors.map((reactor) => reactor.type)).toEqual(['emit', 'notify']);
    // Agent-scoped DB rows win lookup: synchronize any override with the
    // seeded node-default JSON rather than maintaining a second copy.
    expect(sql).toMatch(/UPDATE kernel\.bus_chain_configs\s+SET reactors = \(\s+SELECT reactors/);
    expect(sql).toContain("WHERE event_type = 'agent.reach.delivered' AND scope IS NULL");
    expect(sql).toContain("WHERE event_type = 'agent.reach.delivered' AND scope = 'agent'");
    expect(sql).toContain('ON CONFLICT (event_type, scope) DO UPDATE');
    expect(sql).toContain('enabled = EXCLUDED.enabled');
  });

  it.each(['agent.reach.answered', 'agent.reach.denied'])('keeps legacy %s audit-only', async (eventType) => {
    const cfg = await getChainConfig(eventType, 'agent');
    expect(cfg.reactors.map((reactor) => reactor.type)).toEqual(['audit-log']);
  });

  it('accepts rate_limited as a disclosure-safe denial reason', () => {
    const reason: BusEventMap['agent.reach.denied']['reason'] = 'rate_limited';
    expect(reason).toBe('rate_limited');
  });
});
