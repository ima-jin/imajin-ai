import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { appAuthorizationCodes } from '@/src/db/schemas/app-authorization-codes';

const h = vi.hoisted(() => ({ database: undefined as PgliteDatabase | undefined }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/app-authorization-codes'),
  db: { delete: (...args: Parameters<PgliteDatabase['delete']>) => h.database!.delete(...args) },
}));
import { APP_AUTHORIZATION_CODE_GRACE_MS, sweepAppAuthorizationCodes } from '../app-authorization-code-retention';

const migration = readFileSync(new URL('../../../../../../migrations/0227_app_authorization_code_retention.sql', import.meta.url), 'utf8');
const now = new Date('2026-10-28T12:00:00Z');
const cutoff = now.getTime() - APP_AUTHORIZATION_CODE_GRACE_MS;
let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  h.database = drizzle(client);
  await client.exec('CREATE SCHEMA auth');
  await client.exec(readFileSync(new URL('../../../../../../migrations/0222_app_authorization_codes.sql', import.meta.url), 'utf8'));
}, 30_000);
afterAll(async () => { await client?.close(); });

describe('app authorization code retention', () => {
  it('adds an idempotent index matching the schema and sweep predicate without changing rows', async () => {
    const before = await client.query('SELECT * FROM auth.app_authorization_codes');
    await client.exec(migration);
    await client.exec(migration);
    expect(await client.query('SELECT * FROM auth.app_authorization_codes')).toEqual(before);
    const { rows } = await client.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'auth' AND indexname = 'idx_app_authorization_codes_retention'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('COALESCE(consumed_at, expires_at)');
    const [index] = getTableConfig(appAuthorizationCodes).indexes;
    expect(index.config.name).toBe('idx_app_authorization_codes_retention');
    const expression = index.config.columns[0];
    if (!(expression instanceof SQL)) throw new Error('Retention index must use a SQL expression');
    expect(new PgDialect().sqlToQuery(expression).sql).toBe(
      'coalesce("auth"."app_authorization_codes"."consumed_at", "auth"."app_authorization_codes"."expires_at")',
    );
    // The planner can use the expression index for the exact production predicate.
    await client.exec('SET enable_seqscan = off');
    const plan = await client.query<{ 'QUERY PLAN': string }>(`
      EXPLAIN SELECT 1 FROM auth.app_authorization_codes
      WHERE coalesce(consumed_at, expires_at) < $1::timestamptz
    `, [new Date(cutoff).toISOString()]);
    expect(plan.rows.map(row => row['QUERY PLAN']).join('\n')).toContain('idx_app_authorization_codes_retention');
  });

  it('sweeps only dead codes past grace, preserving live, within-grace and exact-boundary rows', async () => {
    const future = new Date(now.getTime() + 60_000);
    const cases = [
      { codeHash: 'expired-old', expiresAt: new Date(cutoff - 1), consumedAt: null },
      { codeHash: 'consumed-old', expiresAt: future, consumedAt: new Date(cutoff - 1) },
      { codeHash: 'both-old', expiresAt: new Date(cutoff - 1), consumedAt: new Date(cutoff - 1) },
      { codeHash: 'live-unconsumed', expiresAt: future, consumedAt: null },
      { codeHash: 'expired-within-grace', expiresAt: new Date(cutoff + 1), consumedAt: null },
      { codeHash: 'consumed-within-grace', expiresAt: future, consumedAt: new Date(cutoff + 1) },
      { codeHash: 'expired-boundary', expiresAt: new Date(cutoff), consumedAt: null },
      { codeHash: 'consumed-boundary', expiresAt: future, consumedAt: new Date(cutoff) },
      { codeHash: 'recently-consumed-old-expiry', expiresAt: new Date(cutoff - 1), consumedAt: new Date(cutoff + 1) },
    ];
    await h.database!.insert(appAuthorizationCodes).values(cases.map(row => ({
      ...row, appDid: 'did:imajin:app', subjectDid: 'did:imajin:user', attestationId: 'att_fixture',
      callbackUrl: 'https://app.example.test/callback', state: 'fixture',
      createdAt: new Date(cutoff - 86_400_000),
    })));
    const before = await h.database!.select().from(appAuthorizationCodes);
    expect(await sweepAppAuthorizationCodes(now)).toBe(3);
    const survivors = await h.database!.select().from(appAuthorizationCodes);
    const removed = new Set(['expired-old', 'consumed-old', 'both-old']);
    expect(survivors).toEqual(before.filter(row => !removed.has(row.codeHash)));
    expect(await sweepAppAuthorizationCodes(now)).toBe(0);
  });
});
