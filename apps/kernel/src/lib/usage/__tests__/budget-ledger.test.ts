import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { makeAgentRun } from '../../warp/__tests__/run-fixture';
import { computeCostUsd } from '../../inference/pricing';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const { select, getClient, publish } = vi.hoisted(() => ({ select: vi.fn(), getClient: vi.fn(), publish: vi.fn() }));
vi.mock('@imajin/db', () => ({ getClient }));
vi.mock('@/src/lib/inference/usage-ledger', () => ({ publishUsageIncurred: publish }));
vi.mock('@/src/db', async () => ({
  db: { select },
  ...await import('../../../db/schemas/usage'),
  ...await import('../../../db/schemas/auth'),
}));
import { readUsageSummary } from '../summary';
import { recordWarpRunUsage, WARP_CREDIT_RATE_CONFIG } from '../warp-incurred';

const OWNER = 'did:imajin:meter-owner';
const SINCE = new Date('2026-10-19T16:13:00Z');
const NOW = new Date('2026-10-26T16:13:00Z');
let pg: PGlite;
async function taggedSql(strings: TemplateStringsArray, ...values: unknown[]) {
  const text = strings.reduce((query, part, index) => query + (index ? `$${index}` : '') + part, '');
  return (await pg.query(text, values.map(value => value instanceof Date ? value.toISOString() : value))).rows;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`
    CREATE SCHEMA kernel;
    CREATE TABLE kernel.bus_chain_configs (
      event_type text, scope text, reactors jsonb, enabled boolean, updated_at timestamptz,
      UNIQUE NULLS NOT DISTINCT(event_type, scope)
    );
    CREATE SCHEMA registry;
    CREATE TABLE registry.node_config (key text PRIMARY KEY, value jsonb);
  `);
  const migrations = resolve(__dirname, '../../../../../../migrations');
  for (const file of [
    '0119_usage_incurred.sql', '0120_usage_incurred_quantity.sql', '0121_usage_emitters.sql',
    '0146_usage_incurred_status.sql', '0214_usage_incurred_pricing.sql',
    '0122_usage_billed.sql', '0125_usage_billed_manual.sql', '0127_usage_billed_receipts.sql',
  ]) await pg.exec(readFileSync(resolve(migrations, file), 'utf8'));
  await pg.exec(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.attestations (
      id text PRIMARY KEY, type text NOT NULL, subject_did text NOT NULL,
      issued_at timestamptz NOT NULL, revoked_at timestamptz
    );
  `);
  const ledger = drizzle(pg);
  select.mockImplementation(fields => ledger.select(fields));
  getClient.mockReturnValue(Object.assign(taggedSql, { json: (value: unknown) => JSON.stringify(value) }));
  publish.mockResolvedValue(undefined);
  // Fixtures are real ledger rows; production SQL performs every filter,
  // grouping and reconciliation. Only the database handle is redirected.
  await pg.query(`
    INSERT INTO usage.incurred
      (id, principal_did, resource, provider, model, cost_usd, created_at, status)
    VALUES
      ('warp', $1, 'external:warp/run', 'warp', 'run-model', 80, '2026-10-20T10:00:00Z', NULL),
      ('anthropic', $1, 'model:anthropic/model', 'anthropic', 'model', 20, $2, NULL),
      ('moonshot-unpriced', $1, 'model:moonshot/unknown', 'moonshot', 'unknown', NULL, $2, NULL),
      ('failed', $1, 'model:failed/model', 'failed', 'model', 999, $2, 'error'),
      ('before', $1, 'external:warp/old', 'warp', 'prior-model', 15, '2026-10-19T16:12:59.999Z', NULL),
      ('at-upper-bound', $1, 'external:warp/new', 'warp', 'next-model', 40, $3, NULL),
      ('other-principal', 'did:imajin:other', 'external:warp/other', 'warp', 'model', 2000, $2, NULL)
  `, [OWNER, SINCE.toISOString(), NOW.toISOString()]);
  await pg.query(`
    INSERT INTO usage.billed
      (id, principal_did, provider, model, source, granularity, billed_usd, period_start, period_end)
    VALUES
      ('legacy-day', $1, 'warp', 'run-model', 'api', 'day', 100, '2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z'),
      ('legacy-month', $1, 'warp', 'run-model', 'api', 'month', 9999, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'),
      ('legacy-manual', $1, 'moonshot', NULL, 'document', 'manual', 5000, $2, $3)
  `, [OWNER, SINCE.toISOString(), NOW.toISOString()]);
});
afterAll(async () => { await pg?.close(); });

it('reads incurred-only estimates, unknown pricing and exact date bounds independently of legacy billed/drift and window', async () => {
  const query = {
    principalDid: OWNER, from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z'),
    windowLabel: '2026-10',
    budget: { since: SINCE, now: NOW, cap: { amount: 400000, currency: 'USD' } },
    costReport: { from: SINCE, to: new Date('2026-10-20T00:00:00Z'), asOf: NOW },
  };
  const result = await readUsageSummary(query);
  expect(result.incurred.total).toBe(1154);
  expect(result.billed.total).toBe(5100);
  expect(result.drift).toBe(20);
  expect(result.budget?.basis).toBe('meter-estimate');
  expect(result.budget?.incurred).toEqual({
    total: 100, byProvider: { warp: 80, anthropic: 20, moonshot: 0 }, rowCount: 3, unpricedCount: 1,
  });
  expect(result.budget?.remaining).toBe(3900);
  expect(result.budget?.weeks.map(week => [week.week, week.incurred.total, week.cumulative.total]))
    .toEqual([['2026-W43', 100, 100], ['2026-W44', 0, 100]]);
  expect(result.budget?.weeks[1].cumulative.unpricedCount).toBe(1);
  expect(result.budget?.projection).toMatchObject({
    next7Days: 100, dailyRate: 100 / 7, projectedTotalIn7Days: 200,
    incurred: { rowCount: 3, unpricedCount: 1 },
  });
  expect(result.costReport).toEqual({
    from: SINCE.toISOString(), to: query.costReport.to.toISOString(), asOf: NOW.toISOString(), currency: 'USD', basis: 'meter-estimate',
    total: 20, byProvider: { warp: 0, anthropic: 20, moonshot: 0 }, rowCount: 2, unpricedCount: 1,
  });
  const [actual] = (await pg.query<{ total: string; count: number }>(`
    SELECT sum(cost_usd)::text AS total, count(*)::int AS count FROM usage.incurred
    WHERE principal_did = $1 AND created_at >= $2 AND created_at < $3
      AND (status IS NULL OR status <> 'error')
  `, [OWNER, SINCE.toISOString(), NOW.toISOString()])).rows;
  expect(result.budget?.incurred.total).toBe(Number(actual.total));
  expect(result.budget?.incurred.rowCount).toBe(actual.count);
  const unrelatedWindow = await readUsageSummary({
    ...query, from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-09-01T00:00:00Z'), windowLabel: '2026-08',
  });
  expect(unrelatedWindow.incurred.total).toBe(0);
  expect(unrelatedWindow.billed.total).toBe(0);
  expect(unrelatedWindow.drift).toBe(0);
  expect(unrelatedWindow.budget).toEqual(result.budget);
  expect(unrelatedWindow.costReport).toEqual(result.costReport);
  const openPeriod = await readUsageSummary({
    ...query, costReport: { from: SINCE, to: new Date('2026-11-01T00:00:00Z'), asOf: NOW },
  });
  expect(openPeriod.costReport?.total).toBe(100);
  expect(openPeriod.costReport?.asOf).toBe(NOW.toISOString());
  expect(openPeriod.costReport?.to).toBe('2026-11-01T00:00:00.000Z');
});

it('feeds our Warp meter and token rate cards into budget/report without invoices or replay duplication', async () => {
  const principal = 'did:imajin:meter-acceptance';
  const createdAt = '2026-10-20T10:00:00Z';
  const parent = makeAgentRun({
    runId: 'budget-parent', createdAt, modelId: 'warp-model', environmentId: 'environment',
    requestUsage: { inferenceCost: 3700, computeCost: 150, platformCost: 50 },
  });
  const child = makeAgentRun({
    runId: 'budget-child', createdAt, parentRunId: parent.runId, environmentId: null, state: 'FAILED',
    modelId: 'warp-model', requestUsage: { inferenceCost: 2500, computeCost: 75, platformCost: 25 },
  });
  const unknown = makeAgentRun({
    runId: 'budget-unknown', createdAt, state: 'CANCELLED', modelId: 'warp-model', requestUsage: null,
  });
  expect(await recordWarpRunUsage(principal, parent)).toBe(true);
  expect(await recordWarpRunUsage(principal, child)).toBe(true);
  expect(await recordWarpRunUsage(principal, unknown)).toBe(true);
  const moonshot = computeCostUsd('moonshot', 'kimi-k2-0711-preview', 1_000_000, 1_000_000);
  const anthropic = computeCostUsd('anthropic', 'claude-sonnet-4-20250514', 1_000_000, 1_000_000);
  expect(moonshot).toBe(3.1);
  expect(anthropic).toBe(18);
  await pg.query(`
    INSERT INTO usage.incurred
      (id, principal_did, source, resource, provider, model, tokens_in, tokens_out, cost_usd, created_at)
    VALUES
      ('acceptance-moonshot', $1, 'inference-passthrough', 'model:moonshot/kimi-k2-0711-preview',
       'moonshot', 'kimi-k2-0711-preview', 1000000, 1000000, $2, $4),
      ('acceptance-anthropic', $1, 'inference-passthrough', 'model:anthropic/claude-sonnet-4-20250514',
       'anthropic', 'claude-sonnet-4-20250514', 1000000, 1000000, $3, $4)
  `, [principal, moonshot, anthropic, createdAt]);
  await pg.query(`
    INSERT INTO usage.billed
      (id, principal_did, provider, source, granularity, billed_usd, period_start, period_end)
    VALUES ('acceptance-invoice', $1, 'moonshot', 'document', 'manual', 90000, $2, $3)
  `, [principal, SINCE.toISOString(), NOW.toISOString()]);
  const query = {
    principalDid: principal, from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z'),
    windowLabel: '2026-10', budget: { since: SINCE, now: NOW, cap: { amount: 400000, currency: 'USD' } },
    costReport: { from: SINCE, to: new Date('2026-11-01T00:00:00Z'), asOf: NOW },
  };
  const initial = await readUsageSummary(query);
  expect(initial.billed.total).toBe(90000);
  expect(initial.budget?.incurred).toEqual({
    total: 121.1, byProvider: { warp: 100, anthropic: 18, moonshot: 3.1 }, rowCount: 5, unpricedCount: 1,
  });
  expect(initial.budget?.remaining).toBe(3878.9);
  expect(initial.budget?.weeks.map(week => [week.week, week.incurred.total, week.cumulative.total]))
    .toEqual([['2026-W43', 121.1, 121.1], ['2026-W44', 0, 121.1]]);
  expect(initial.budget?.projection).toMatchObject({
    next7Days: 121.1, dailyRate: 121.1 / 7, projectedTotalIn7Days: 242.2,
  });
  expect(initial.costReport?.total).toBe(121.1);
  expect(initial.costReport?.unpricedCount).toBe(1);
  expect(await recordWarpRunUsage(principal, parent)).toBe(false);
  expect(await recordWarpRunUsage(principal, child)).toBe(false);
  expect(await recordWarpRunUsage(principal, unknown)).toBe(false);
  expect(await readUsageSummary(query)).toEqual(initial);

  await pg.query('INSERT INTO registry.node_config (key, value) VALUES ($1, $2)',
    [WARP_CREDIT_RATE_CONFIG, JSON.stringify({ usd: 200, credits: 6500 })]);
  expect(await recordWarpRunUsage(principal, {
    ...parent, createdAt: '2026-11-02T10:00:00Z',
    requestUsage: { inferenceCost: 10200, computeCost: 150, platformCost: 50 },
  })).toBe(true);
  const grown = await readUsageSummary(query);
  expect(grown.budget?.incurred.total).toBe(221.1);
  expect(grown.budget?.incurred.byProvider.warp).toBe(200);
  expect(grown.costReport?.total).toBe(221.1);
  expect(grown.budget?.remaining).toBe(3778.9);
  expect(grown.budget?.weeks[0].cumulative.total).toBe(221.1);
  expect(await recordWarpRunUsage(principal, {
    ...unknown, requestUsage: { inferenceCost: 6500, computeCost: null, platformCost: null },
  })).toBe(true);
  const priced = await readUsageSummary(query);
  expect(priced.budget?.incurred).toMatchObject({ total: 321.1, rowCount: 5, unpricedCount: 0 });
  expect(priced.costReport?.total).toBe(321.1);
  expect(priced.costReport?.unpricedCount).toBe(0);
  const [actual] = (await pg.query<{ total: string; credits: string; usd: string }>(`
    SELECT sum(cost_usd)::text AS total, sum((pricing->>'credits')::numeric)::text AS credits,
           min(pricing->'creditRate'->>'usd') AS usd
    FROM usage.incurred WHERE principal_did = $1 AND created_at >= $2 AND created_at < $3
  `, [principal, SINCE.toISOString(), NOW.toISOString()])).rows;
  expect(priced.budget?.incurred.total).toBe(Number(actual.total));
  expect(Number(actual.credits)).toBe(19500);
  expect(actual.usd).toBe('100');
});
