import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgentRun } from '../../../warp/__tests__/run-fixture';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const { getClient, list } = vi.hoisted(() => ({ getClient: vi.fn(), list: vi.fn() }));
vi.mock('@imajin/db', () => ({ getClient }));
vi.mock('@/src/lib/warp/dispatch', () => ({
  listAgentRuns: list,
  isTerminalRunState: (state: string) => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(state),
}));

import { ingestWarpBilledUsage, WARP_CREDIT_RATE_CONFIG } from '../warp';
import { ingestBilledUsage } from '../ingest';

const NOW = new Date('2026-10-21T12:00:00Z');
const OWNER = 'did:imajin:owner';
const CREATED = '2026-10-19T12:00:00Z';
const migrationPath = resolve(__dirname, '../../../../../../../migrations');
const migration = readFileSync(resolve(migrationPath, '0214_usage_billed_warp_runs.sql'), 'utf8');
let pg: PGlite;
let originalParentIndex: unknown[];

// Executes production tagged SQL, without interpreting its conditional logic.
// PGlite serializes statements, so this tests atomic guards, not backend locks.
async function sql(strings: TemplateStringsArray, ...values: unknown[]) {
  const text = strings.reduce((query, part, index) => query + (index ? `$${index}` : '') + part, '');
  return (await pg.query(text, values.map(value => value instanceof Date ? value.toISOString() : value))).rows;
}

function runs(credits: number, ids = ['run-a']) {
  list.mockResolvedValue({
    hasNextPage: false, nextCursor: null,
    runs: ids.map(runId => makeAgentRun({
      runId, createdAt: CREATED, updatedAt: '2026-10-20T12:00:00Z', modelId: null,
      requestUsage: { inferenceCost: credits, computeCost: 0, platformCost: 0 },
    })),
  });
}

async function rate(usd: number) {
  await pg.query('INSERT INTO registry.node_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [WARP_CREDIT_RATE_CONFIG, JSON.stringify({ usd, credits: 6500 })]);
}
async function snapshot() {
  return (await pg.query('SELECT * FROM usage.billed ORDER BY id')).rows;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  for (const name of ['0122_usage_billed.sql', '0125_usage_billed_manual.sql', '0127_usage_billed_receipts.sql']) {
    await pg.exec(readFileSync(resolve(migrationPath, name), 'utf8'));
  }
  originalParentIndex = (await pg.query("SELECT indexdef FROM pg_indexes WHERE schemaname = 'usage' AND tablename = 'billed' ORDER BY indexname")).rows;
  await pg.exec(migration);
  await pg.exec('CREATE SCHEMA registry; CREATE TABLE registry.node_config (key text PRIMARY KEY, value jsonb)');
  getClient.mockReturnValue(Object.assign(sql, { json: (value: unknown) => JSON.stringify(value) }));
});
beforeEach(async () => {
  await pg.exec('TRUNCATE usage.billed, registry.node_config');
  runs(6500);
});
afterAll(async () => { await pg?.close(); });

describe('Warp billed production SQL against embedded PostgreSQL', () => {
  it('exposes inherited run rows to ordinary parent aggregates without changing parent indexes', async () => {
    runs(6500, ['run-a', 'run-b']);
    await ingestWarpBilledUsage(OWNER, NOW);
    expect((await pg.query('SELECT count(*)::int AS count, sum(billed_usd)::text AS total FROM usage.billed')).rows)
      .toEqual([{ count: 2, total: '200.00000000' }]);
    expect((await pg.query('SELECT count(*)::int AS count FROM ONLY usage.billed')).rows)
      .toEqual([{ count: 0 }]);
    expect((await pg.query("SELECT indexdef FROM pg_indexes WHERE schemaname = 'usage' AND tablename = 'billed' ORDER BY indexname")).rows)
      .toEqual(originalParentIndex);
    expect((await pg.query("SELECT inhparent::regclass::text AS parent FROM pg_inherits WHERE inhrelid = 'usage.billed_warp_runs'::regclass")).rows)
      .toEqual([{ parent: 'usage.billed' }]);
  });

  it('enforces its own run-ID primary key and fixed provider/source/granularity constraints', async () => {
    await ingestWarpBilledUsage(OWNER, NOW);
    await expect(pg.exec('INSERT INTO usage.billed_warp_runs SELECT * FROM usage.billed_warp_runs'))
      .rejects.toMatchObject({ code: '23505' });
    await expect(pg.exec("UPDATE usage.billed_warp_runs SET provider = 'other'"))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pg.exec("UPDATE usage.billed_warp_runs SET granularity = 'day'"))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pg.exec("UPDATE usage.billed_warp_runs SET source = 'manual'"))
      .rejects.toMatchObject({ code: '23514' });
    expect(await snapshot()).toMatchObject([{ provider: 'warp', granularity: 'run', source: 'api' }]);
  });
  it('is a complete no-op on unchanged re-ingest, even after config and metadata change', async () => {
    expect(await ingestWarpBilledUsage(OWNER, NOW)).toBe(1);
    const before = await snapshot();
    await rate(200);
    expect(await ingestWarpBilledUsage(OWNER, new Date('2026-11-01T12:00:00Z'))).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it('updates resumed cumulative usage at the original rate and original creation time', async () => {
    await ingestWarpBilledUsage(OWNER, NOW);
    await rate(200);
    runs(13000);
    expect(await ingestWarpBilledUsage(OWNER, NOW)).toBe(1);
    expect(await snapshot()).toMatchObject([{
      billed_usd: '200.00000000', period_start: new Date(CREATED),
      raw: { credits: 13000, creditRate: { usd: 100, credits: 6500 } },
    }]);
    const before = await snapshot();
    runs(6500);
    expect(await ingestWarpBilledUsage(OWNER, NOW)).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it('uses configured rates for new lines, keeps same-time/model runs distinct, and scopes IDs to principal', async () => {
    await rate(50);
    runs(6500, ['run-a', 'run-b']);
    expect(await ingestWarpBilledUsage(OWNER, NOW)).toBe(2);
    expect(await ingestWarpBilledUsage('did:imajin:other', NOW)).toBe(2);
    const rows = await snapshot();
    expect(rows).toHaveLength(4);
    expect(rows.every(row => row.model === null && row.billed_usd === '50.00000000')).toBe(true);
    expect(new Set(rows.map(row => row.id)).size).toBe(4);
  });

  it('atomically permits only one insert/growth when passes overlap', async () => {
    expect((await Promise.all([ingestWarpBilledUsage(OWNER, NOW), ingestWarpBilledUsage(OWNER, NOW)])).sort((a, b) => a - b))
      .toEqual([0, 1]);
    runs(13000);
    expect((await Promise.all([ingestWarpBilledUsage(OWNER, NOW), ingestWarpBilledUsage(OWNER, NOW)])).sort((a, b) => a - b))
      .toEqual([0, 1]);
    expect(await snapshot()).toMatchObject([{ billed_usd: '200.00000000' }]);
  });

  it('reapplies migration without losing run rows and preserves day/month bucket upserts', async () => {
    await ingestWarpBilledUsage(OWNER, NOW);
    const before = await snapshot();
    await pg.exec(migration);
    await pg.exec(migration);
    expect(await snapshot()).toEqual(before);
    for (const granularity of ['day', 'month'] as const) {
      const params = {
        principalDid: OWNER, provider: 'anthropic', granularity,
        period: { start: new Date(CREATED), end: NOW },
        lines: [{ model: null, tokensIn: null, tokensOut: null, billedUsd: 1, raw: {} }],
      };
      await ingestBilledUsage(params);
      params.lines[0].billedUsd = 2;
      await ingestBilledUsage(params);
    }
    const rows = (await pg.query('SELECT granularity, count(*)::int AS count, sum(billed_usd)::text AS total FROM usage.billed GROUP BY granularity ORDER BY granularity')).rows;
    expect(rows).toEqual([
      { granularity: 'day', count: 1, total: '2.00000000' },
      { granularity: 'month', count: 1, total: '2.00000000' },
      { granularity: 'run', count: 1, total: '100.00000000' },
    ]);
  });
});
