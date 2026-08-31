/**
 * Structured reactor-chain resolution debug logging in publish() (#1859).
 *
 * publish() previously resolved a reactor chain with no observable signal: a
 * chain silently missing an expected reactor (as happened with
 * `attestation-notify` in #1853) required diffing source to discover. Every
 * publish() call must now emit a `debug`-level structured log naming the
 * event type/scope, the resolved reactor count and types, and whether the
 * chain came from `kernel.bus_chain_configs` (DB) or the hardcoded DEFAULTS
 * fallback — see packages/bus/src/publish.ts and src/config.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDebug } = vi.hoisted(() => ({ mockDebug: vi.fn() }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: mockDebug }),
}));

// Fake postgres.js tagged-template client — see packages/bus/AGENTS.md.
// Both the scoped and scope-IS-NULL lookups in fetchChainConfigFromDb() hit
// the same fake, so an empty `rows` value exercises the DEFAULTS fallback and
// a non-empty one exercises the DB-sourced path.
const { fakeSql, setDbRows } = vi.hoisted(() => {
  let rows: Array<Record<string, unknown>> = [];
  const fakeSql = (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve(rows);
  return {
    fakeSql,
    setDbRows: (next: Array<Record<string, unknown>>) => {
      rows = next;
    },
  };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

vi.mock('../src/registry', () => ({
  getReactor: (type: string) => {
    if (type === 'emit') return vi.fn().mockResolvedValue(undefined);
    return undefined;
  },
}));

import { publish } from '../src/publish';

beforeEach(() => {
  mockDebug.mockClear();
  setDbRows([]);
});

describe('reactor chain resolution debug logging (#1859)', () => {
  it('logs event type, scope, resolved reactor count/types, and source=defaults when no DB row exists', async () => {
    await publish('session.created', {
      issuer: 'did:imajin:alice',
      subject: 'did:imajin:alice',
      scope: 'test-chain-log-defaults',
      payload: { tier: 'standard' },
    });

    expect(mockDebug).toHaveBeenCalledTimes(1);
    const [ctx, message] = mockDebug.mock.calls[0];
    expect(message).toBe('Resolved reactor chain for publish()');
    expect(ctx).toMatchObject({
      event: 'session.created',
      scope: 'test-chain-log-defaults',
      reactorCount: 1,
      reactorTypes: ['emit'],
      source: 'defaults',
    });
  });

  it('logs source=db when the chain is resolved from a bus_chain_configs row', async () => {
    setDbRows([
      {
        reactors: [{ type: 'emit', config: {}, enabled: true }],
        enabled: true,
      },
    ]);

    await publish('session.created', {
      issuer: 'did:imajin:alice',
      subject: 'did:imajin:alice',
      scope: 'test-chain-log-db',
      payload: { tier: 'standard' },
    });

    expect(mockDebug).toHaveBeenCalledTimes(1);
    const [ctx] = mockDebug.mock.calls[0];
    expect(ctx).toMatchObject({
      event: 'session.created',
      scope: 'test-chain-log-db',
      reactorCount: 1,
      reactorTypes: ['emit'],
      source: 'db',
    });
  });

  it('still logs the resolved chain (empty) before throwing on an unregistered reactor', async () => {
    setDbRows([
      {
        reactors: [{ type: 'missing-reactor', config: {}, enabled: true }],
        enabled: true,
      },
    ]);

    await expect(
      publish('session.created', {
        issuer: 'did:imajin:alice',
        subject: 'did:imajin:alice',
        scope: 'test-chain-log-missing',
        payload: { tier: 'standard' },
      })
    ).rejects.toThrow(/Unknown reactor\(s\) in chain/);

    expect(mockDebug).toHaveBeenCalledTimes(1);
    const [ctx] = mockDebug.mock.calls[0];
    expect(ctx).toMatchObject({
      reactorCount: 1,
      reactorTypes: ['missing-reactor'],
      source: 'db',
    });
  });
});
