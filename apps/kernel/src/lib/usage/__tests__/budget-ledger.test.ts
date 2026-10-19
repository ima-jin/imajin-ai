import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const { select } = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@/src/db', async () => ({
  db: { select },
  ...await import('../../../db/schemas/usage'),
  ...await import('../../../db/schemas/auth'),
}));
import { readUsageSummary } from '../summary';

const OWNER = 'did:imajin:meter-owner';
const SINCE = new Date('2026-10-19T16:13:00Z');
const NOW = new Date('2026-10-26T16:13:00Z');
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  const migrations = resolve(__dirname, '../../../../../../migrations');
  for (const file of [
    '0119_usage_incurred.sql', '0146_usage_incurred_status.sql',
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
    costReport: { from: SINCE, to: new Date('2026-10-20T00:00:00Z') },
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
    from: SINCE.toISOString(), to: query.costReport.to.toISOString(), currency: 'USD', basis: 'meter-estimate',
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
});
