/**
 * `usage.billed` shape tests (#1076 Stage 1).
 *
 * Two complementary checks: the drizzle schema declares the columns the
 * application code actually reads/writes, and the raw migration SQL
 * (migrations/0122_usage_billed.sql — the one `scripts/migrate.mjs` runs
 * against a real database, never drizzle-kit push) still declares the table,
 * NOT NULL columns, and the functional unique index the ingest upsert
 * targets. The two are maintained by hand in this repo (plain SQL
 * migrations, see AGENTS.md), so nothing enforces they stay in sync except a
 * test that reads both.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { usageBilled } from '../usage';

describe('usageBilled drizzle schema', () => {
  it('declares every column the ingest/reconciliation code depends on', () => {
    const columns = getTableColumns(usageBilled);
    const dbNames = Object.fromEntries(Object.entries(columns).map(([key, col]) => [key, col.name]));

    expect(dbNames).toEqual({
      id: 'id',
      principalDid: 'principal_did',
      provider: 'provider',
      periodStart: 'period_start',
      periodEnd: 'period_end',
      granularity: 'granularity',
      model: 'model',
      tokensIn: 'tokens_in',
      tokensOut: 'tokens_out',
      billedUsd: 'billed_usd',
      raw: 'raw',
      fetchedAt: 'fetched_at',
    });
  });

  it('requires principal_did, provider, period bounds and granularity, and leaves model/tokens/cost nullable', () => {
    const columns = getTableColumns(usageBilled);

    expect(columns.principalDid.notNull).toBe(true);
    expect(columns.provider.notNull).toBe(true);
    expect(columns.periodStart.notNull).toBe(true);
    expect(columns.periodEnd.notNull).toBe(true);
    expect(columns.granularity.notNull).toBe(true);

    expect(columns.model.notNull).toBe(false);
    expect(columns.tokensIn.notNull).toBe(false);
    expect(columns.tokensOut.notNull).toBe(false);
    expect(columns.billedUsd.notNull).toBe(false);
    expect(columns.raw.notNull).toBe(false);
  });
});

describe('migrations/0122_usage_billed.sql', () => {
  const sql = readFileSync(resolve(__dirname, '../../../../../../migrations/0122_usage_billed.sql'), 'utf-8');

  it('creates the usage.billed table with every required column', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS usage\.billed/);
    for (const column of [
      'id\\s+TEXT', 'principal_did\\s+TEXT\\s+NOT NULL', 'provider\\s+TEXT\\s+NOT NULL',
      'period_start\\s+TIMESTAMPTZ\\s+NOT NULL', 'period_end\\s+TIMESTAMPTZ\\s+NOT NULL',
      'granularity\\s+TEXT\\s+NOT NULL', 'model\\s+TEXT', 'tokens_in\\s+BIGINT', 'tokens_out\\s+BIGINT',
      'billed_usd\\s+NUMERIC\\(20, 8\\)', 'raw\\s+JSONB', 'fetched_at\\s+TIMESTAMPTZ\\s+NOT NULL DEFAULT now\\(\\)',
    ]) {
      expect(sql).toMatch(new RegExp(column));
    }
  });

  it('idempotently upserts on (principal_did, provider, period_start, granularity, COALESCE(model, \'\'))', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uniq_usage_billed_period/);
    expect(sql).toMatch(/ON usage\.billed \(principal_did, provider, period_start, granularity, COALESCE\(model, ''\)\)/);
  });

  it('never touches usage.incurred (owned by #1148/#1151, out of scope here)', () => {
    expect(sql).not.toMatch(/ALTER TABLE usage\.incurred/);
    expect(sql).not.toMatch(/usage\.incurred\s+(ADD|DROP|ALTER)/);
  });
});
