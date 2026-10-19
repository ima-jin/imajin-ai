import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeAgentRun } from '../../warp/__tests__/run-fixture';
import { usageBilled } from '../../../db/schemas/usage';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const { getClient, list, select } = vi.hoisted(() => ({
  getClient: vi.fn(), list: vi.fn(), select: vi.fn(),
}));
vi.mock('@imajin/db', () => ({ getClient }));
vi.mock('@/src/db', async () => ({
  db: { select },
  ...await import('../../../db/schemas/usage'),
  ...await import('../../../db/schemas/auth'),
}));
vi.mock('@/src/lib/warp/dispatch', () => ({
  listAgentRuns: list,
  isTerminalRunState: (state: string) => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(state),
}));

import { ingestWarpBilledUsage, WARP_CREDIT_RATE_CONFIG } from '../billed/warp';
import { readUsageSummary } from '../summary';

const OWNER = 'did:imajin:budget-owner';
const OTHER = 'did:imajin:other-owner';
const NOW = new Date('2026-10-26T16:13:00Z');
const SINCE = new Date('2026-10-19T16:13:00Z');
const CREATED = '2026-10-20T10:00:00Z';
const MODEL = 'claude-sonnet';
const migrations = resolve(__dirname, '../../../../../../migrations');
let pg: PGlite;
let ledger: ReturnType<typeof drizzle>;

// Production tagged SQL executes in PostgreSQL; no SQL/guard interpretation.
async function taggedSql(strings: TemplateStringsArray, ...values: unknown[]) {
  const text = strings.reduce((query, part, index) => query + (index ? `$${index}` : '') + part, '');
  return (await pg.query(text, values.map(value => value instanceof Date ? value.toISOString() : value))).rows;
}

function run(runId: string, credits: number, overrides: Parameters<typeof makeAgentRun>[0] = {}) {
  return makeAgentRun({
    runId, createdAt: CREATED, updatedAt: '2026-10-20T11:00:00Z',
    modelId: MODEL, requestUsage: { inferenceCost: credits - 100, computeCost: 75, platformCost: 25 },
    ...overrides,
  });
}

function providerRuns(parentCredits = 3900) {
  list.mockResolvedValue({ hasNextPage: false, nextCursor: null, runs: [
    run('parent', parentCredits, { environmentId: 'environment' }),
    run('child', 2600, { parentRunId: 'parent', environmentId: null, state: 'FAILED' }),
    run('before-budget', 650, { createdAt: '2026-10-19T16:12:59.999Z', modelId: 'prior-model' }),
  ] });
}

function summary() {
  return readUsageSummary({
    principalDid: OWNER,
    from: new Date('2026-10-01T00:00:00Z'),
    to: new Date('2026-11-01T00:00:00Z'),
    windowLabel: '2026-10',
    budget: { since: SINCE, now: NOW, cap: { amount: 400000, currency: 'USD' } },
  });
}

async function actualBudgetSum() {
  const [result] = (await pg.query<{ total: string }>(`
    SELECT sum(billed_usd)::text AS total FROM usage.billed
    WHERE principal_did = $1 AND period_start >= $2 AND period_start < $3
      AND (source <> 'api' OR granularity IN ('day', 'run'))
  `, [OWNER, SINCE.toISOString(), NOW.toISOString()])).rows;
  return Number(result.total);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  for (const file of [
    '0119_usage_incurred.sql', '0122_usage_billed.sql',
    '0125_usage_billed_manual.sql', '0127_usage_billed_receipts.sql',
    '0214_usage_billed_warp_runs.sql',
  ]) {
    await pg.exec(readFileSync(resolve(migrations, file), 'utf8'));
  }
  await pg.exec(`
    CREATE SCHEMA registry;
    CREATE TABLE registry.node_config (key text PRIMARY KEY, value jsonb);
    CREATE SCHEMA auth;
    CREATE TABLE auth.attestations (
      id text PRIMARY KEY, type text NOT NULL, subject_did text NOT NULL,
      issued_at timestamptz NOT NULL, revoked_at timestamptz
    );
  `);
  ledger = drizzle(pg);
  select.mockImplementation((fields) => ledger.select(fields));
  getClient.mockReturnValue(Object.assign(taggedSql, { json: (value: unknown) => JSON.stringify(value) }));
});
afterAll(async () => { await pg?.close(); });

describe('budget acceptance over the real billed ledger', () => {
  it('matches ingested parent/child USD, excludes duplicate/month and other-principal spend, and preserves idempotent resumed rates', async () => {
    providerRuns();
    expect(await ingestWarpBilledUsage(OWNER, NOW)).toBe(3);
    const [warpActual] = (await pg.query<{ credits: string; total: string }>(`
      SELECT sum((raw->>'credits')::numeric)::text AS credits,
             sum(billed_usd)::text AS total
      FROM usage.billed WHERE principal_did = $1 AND provider = 'warp'
        AND period_start >= $2 AND period_start < $3
    `, [OWNER, SINCE.toISOString(), NOW.toISOString()])).rows;
    expect(Number(warpActual.credits)).toBe(6500);
    expect(Number(warpActual.total)).toBe(100);

    await ledger.insert(usageBilled).values([
      { id: 'moonshot-receipt', principalDid: OWNER, provider: 'moonshot', source: 'document', granularity: 'manual',
        periodStart: SINCE, periodEnd: SINCE, currency: 'USD', amountMinor: 5000, billedUsd: '50',
        evidenceAssetId: 'asset-receipt', evidenceContentHash: 'receipt-hash', category: 'top-up' },
      { id: 'anthropic-day', principalDid: OWNER, provider: 'anthropic', source: 'api', granularity: 'day',
        periodStart: new Date(CREATED), periodEnd: new Date('2026-10-21T00:00:00Z'), billedUsd: '20' },
      { id: 'anthropic-month', principalDid: OWNER, provider: 'anthropic', source: 'api', granularity: 'month',
        periodStart: SINCE, periodEnd: NOW, billedUsd: '999' },
      { id: 'other-owner', principalDid: OTHER, provider: 'warp', source: 'api', granularity: 'run',
        periodStart: SINCE, periodEnd: NOW, billedUsd: '999' },
    ]);
    // Only columns actually read by the production summary/reconciliation are
    // required from the incurred migration; later unrelated schema is not faked.
    await pg.query(`
      INSERT INTO usage.incurred (id, principal_did, resource, provider, model, cost_usd, created_at)
      VALUES ('incurred-owner', $1, 'model:warp/claude-sonnet', 'warp', $2, 80, $3),
             ('incurred-other', $4, 'model:warp/claude-sonnet', 'warp', $2, 999, $3)
    `, [OWNER, MODEL, CREATED, OTHER]);
    await pg.query(`
      INSERT INTO auth.attestations (id, type, subject_did, issued_at, revoked_at)
      VALUES ('rollup-active', 'usage.rollup', $1, '2026-10-21T00:00:00Z', NULL),
             ('rollup-revoked', 'usage.rollup', $1, '2026-10-22T00:00:00Z', '2026-10-23T00:00:00Z'),
             ('rollup-other', 'usage.rollup', $2, '2026-10-24T00:00:00Z', NULL)
    `, [OWNER, OTHER]);

    const initial = await summary();
    expect(initial.incurred).toEqual({ total: 80, byProvider: { warp: 80 } });
    expect(initial.billed).toEqual({
      total: 180, byVendor: { warp: 110, anthropic: 20, moonshot: 50 }, bySource: { api: 130, document: 50 },
    });
    expect(initial.drift).toBe(20);
    expect(initial.rollup).toEqual({ attestationId: 'rollup-active', signedAt: '2026-10-21T00:00:00.000Z' });
    expect(initial.budget?.billed).toEqual({ total: 170, byVendor: { warp: 100, anthropic: 20, moonshot: 50 } });
    expect(initial.budget?.billed.total).toBe(await actualBudgetSum());
    expect(initial.budget?.remaining).toBe(3830);
    expect(initial.budget?.weeks.map(week => [week.week, week.billed.total, week.cumulative.total]))
      .toEqual([['2026-W43', 170, 170], ['2026-W44', 0, 170]]);
    expect(initial.budget?.weeks[1].cumulative).toEqual(initial.budget?.billed);
    expect(initial.budget?.projection).toMatchObject({
      dailyRate: 170 / 7, next7Days: 170, projectedTotalIn7Days: 340, capReached: false,
    });
    const expectedCap = new Date(NOW.getTime() + 3830 / (170 / 7) * 86_400_000).toISOString();
    expect(initial.budget?.projection.projectedCapDate).toBe(expectedCap);
    const unrelatedWindow = await readUsageSummary({
      principalDid: OWNER, from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-09-01T00:00:00Z'),
      windowLabel: '2026-08', budget: { since: SINCE, now: NOW, cap: { amount: 400000, currency: 'USD' } },
    });
    expect(unrelatedWindow.incurred.total).toBe(0);
    expect(unrelatedWindow.billed.total).toBe(0);
    expect(unrelatedWindow.drift).toBe(0);
    expect(unrelatedWindow.rollup).toBeNull();
    expect(unrelatedWindow.budget).toEqual(initial.budget);

    expect(await ingestWarpBilledUsage(OWNER, NOW)).toBe(0);
    expect(await summary()).toEqual(initial);
    await pg.query('INSERT INTO registry.node_config (key, value) VALUES ($1, $2)',
      [WARP_CREDIT_RATE_CONFIG, JSON.stringify({ usd: 200, credits: 6500 })]);
    providerRuns(10400);
    expect(await ingestWarpBilledUsage(OWNER, NOW)).toBe(1);
    const grown = await summary();
    expect(grown.budget?.billed.total).toBe(await actualBudgetSum());
    expect(grown.budget?.billed.byVendor.warp).toBe(200);
    expect(grown.budget?.billed.total).toBe(270);
    expect(grown.budget?.remaining).toBe(3730);
    expect(grown.incurred).toEqual(initial.incurred);
    expect(grown.drift).toBe(120);
    expect(grown.budget?.projection.next7Days).toBe(270);
    const [persisted] = (await pg.query<{ usd: string }>(`
      SELECT raw->'creditRate'->>'usd' AS usd FROM usage.billed WHERE raw->>'runId' = 'parent'
    `)).rows;
    expect(persisted.usd).toBe('100');
    expect(await ingestWarpBilledUsage(OWNER, NOW)).toBe(0);
    expect(await summary()).toEqual(grown);
  });
});
