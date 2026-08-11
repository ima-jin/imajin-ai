/**
 * `telemetry.*` default reactor chains (#1677) — the persistence half of the
 * telemetry ingestion pattern. What matters here is that every accepted
 * telemetry event reaches the durable audit trail (`audit-log`, #1140) and the
 * live event stream (`emit`) by default, without needing a `bus_chain_configs`
 * row seeded first.
 */
import { describe, it, expect, vi } from 'vitest';

// Force chain-config lookups to miss the DB so getChainConfig() falls back to
// the hardcoded DEFAULTS map, the same way warp-run.test.ts and supply.test.ts do.
vi.mock('@imajin/db', () => ({
  getClient: () => () => Promise.resolve([]),
}));

import { getChainConfig } from '../src/config';
import type { BusEventMap } from '../src/types';

const TELEMETRY_SCOPE = 'telemetry';

describe('telemetry.* default chains', () => {
  it.each(['telemetry.usage', 'telemetry.error', 'telemetry.lifecycle'] as const)(
    'persists %s to the audit log and the live event stream by default',
    async (eventType) => {
      const cfg = await getChainConfig(eventType, TELEMETRY_SCOPE);

      expect(cfg.reactors.map((r) => r.type)).toEqual(['audit-log', 'emit']);
      expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
    },
  );

  it('does not sign an attestation for every usage tick (deliberately, by design)', async () => {
    const cfg = await getChainConfig('telemetry.usage', TELEMETRY_SCOPE);
    expect(cfg.reactors.some((r) => r.type === 'attestation')).toBe(false);
  });
});

describe('telemetry.usage payload', () => {
  it('type-checks a usage event carrying token counts and a session correlation', () => {
    const usage = {
      schema: 'usage.tokens',
      data: { input: 120, output: 45, cacheRead: 0, cacheWrite: 0 },
      sessionRef: 'run_abc123',
      context_id: 'run_abc123',
      context_type: 'telemetry',
    } satisfies BusEventMap['telemetry.usage'];

    expect(usage.context_id).toBe(usage.sessionRef);
    expect(usage.data.input).toBe(120);
  });

  it('type-checks a usage event reported by a delegated agent', () => {
    const usage = {
      agent: 'did:imajin:jin-agent',
      schema: 'usage.cost',
      data: { amount: 0.42 },
      context_id: 'usage.cost',
      context_type: 'telemetry',
    } satisfies BusEventMap['telemetry.usage'];

    expect(usage.agent).toBe('did:imajin:jin-agent');
  });

  it('type-checks a telemetry.error event', () => {
    const error = {
      schema: 'error.rate_limit',
      data: { code: 429, message: 'rate limited' },
      context_id: 'error.rate_limit',
      context_type: 'telemetry',
    } satisfies BusEventMap['telemetry.error'];

    expect(error.data.code).toBe(429);
  });

  it('type-checks a telemetry.lifecycle event', () => {
    const lifecycle = {
      schema: 'lifecycle.session',
      data: { state: 'started' },
      context_id: 'lifecycle.session',
      context_type: 'telemetry',
    } satisfies BusEventMap['telemetry.lifecycle'];

    expect(lifecycle.data.state).toBe('started');
  });
});
