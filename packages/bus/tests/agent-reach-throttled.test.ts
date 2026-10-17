import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeSql, mockSubscriber } = vi.hoisted(() => ({
  fakeSql: vi.fn(),
  mockSubscriber: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../src/subscriptions', () => ({ deliverToSubscribers: mockSubscriber }));
vi.mock('../src/chain-observer', () => ({ observeChain: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/registry', async () => {
  const { auditLogReactor } = await import('../src/reactors/audit-log');
  return { getReactor: (type: string) => type === 'audit-log' ? auditLogReactor : undefined };
});

import { getChainConfig } from '../src/config';
import { publish } from '../src/publish';
import type { BusEventMap } from '../src/types';

type ThrottledPayload = BusEventMap['agent.reach.throttled'];
const PRINCIPAL = 'did:imajin:principal';
const PAYLOAD: ThrottledPayload = {
  principalDid: PRINCIPAL,
  requesterDid: 'did:imajin:requester',
  dimension: 'tier',
  tier: 'soft',
  retryAfter: 60,
  context_id: PRINCIPAL,
  context_type: 'agent.reach',
};

function publishThrottled(payload: ThrottledPayload) {
  return publish('agent.reach.throttled', {
    issuer: 'did:imajin:node', subject: PRINCIPAL, scope: 'agent', payload,
  });
}

function auditWrites() {
  return fakeSql.mock.calls.filter(([strings]) => strings.join('').includes('INSERT INTO kernel.audit_log'));
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeSql.mockImplementation(() => Promise.resolve([]));
});

describe('Reach throttling audit contract (#2599)', () => {
  it.each<ThrottledPayload['dimension']>(['ip', 'tier', 'stub', 'principal', 'daily'])(
    'persists only allowlisted metadata for %s throttling',
    async (dimension) => {
      const metadata = { ...PAYLOAD, dimension };
      const payload = {
        ...metadata,
        ip: 'PRIVATE_IP', ipHash: 'PRIVATE_IP_HASH', key: 'PRIVATE_LIMITER_KEY',
        body: 'PRIVATE_BODY', message: 'PRIVATE_MESSAGE', signature: 'PRIVATE_SIGNATURE',
      };
      await publishThrottled(payload);

      expect(auditWrites()).toHaveLength(1);
      const values = auditWrites()[0].slice(1);
      expect(values.slice(1, 5)).toEqual(['agent.reach.throttled', 'agent', 'did:imajin:node', PRINCIPAL]);
      expect(JSON.parse(values[6] as string)).toEqual(metadata);
      expect(JSON.stringify(auditWrites())).not.toContain('PRIVATE_');
    },
  );

  it('permits pre-auth IP throttles without a requester DID or tier', async () => {
    const payload: ThrottledPayload = {
      principalDid: PRINCIPAL, dimension: 'ip', retryAfter: 1,
      context_id: PRINCIPAL, context_type: 'agent.reach',
    };
    await publishThrottled(payload);
    expect(JSON.parse(auditWrites()[0][7] as string)).toEqual(payload);
  });

  it('waits for the audit insert before publish resolves', async () => {
    let releaseWrite!: () => void;
    const write = new Promise<unknown[]>((resolve) => { releaseWrite = () => resolve([]); });
    fakeSql.mockImplementation((strings: TemplateStringsArray) =>
      strings.join('').includes('INSERT INTO kernel.audit_log') ? write : Promise.resolve([]));
    let published = false;
    const pending = publishThrottled(PAYLOAD).then(() => { published = true; });

    await vi.waitFor(() => expect(auditWrites()).toHaveLength(1));
    expect(published).toBe(false);
    releaseWrite();
    await pending;
    expect(published).toBe(true);
  });

  it('seeds the identical awaited audit-only fallback and synchronizes agent overrides', async () => {
    const sql = readFileSync(new URL('../../../migrations/0204_seed_agent_reach_throttled_chain.sql', import.meta.url), 'utf8');
    const literal = sql.match(/'(\[[^\n]+\])'::jsonb/)?.[1];
    expect(literal).toBeDefined();
    const config = await getChainConfig('agent.reach.throttled', 'agent');
    expect(config.source).toBe('defaults');
    expect(JSON.parse(literal!)).toEqual(config.reactors);
    expect(config.reactors).toEqual([{
      type: 'audit-log',
      config: { fields: Object.keys(PAYLOAD) },
      await: true,
      enabled: true,
    }]);
    expect(sql).toContain('-- owner: kernel');
    expect(sql).toMatch(/UPDATE kernel\.bus_chain_configs\s+SET reactors = \(\s+SELECT reactors/);
    expect(sql).toContain("WHERE event_type = 'agent.reach.throttled' AND scope IS NULL");
    expect(sql).toContain("WHERE event_type = 'agent.reach.throttled' AND scope = 'agent'");
    expect(sql).toContain('ON CONFLICT (event_type, scope) DO UPDATE');
    expect(sql).toContain('enabled = EXCLUDED.enabled');
  });
});
