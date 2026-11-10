import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { alphaSubmissions } from '@/src/db/schemas/www';
import { ALPHA_INTENTS } from '../contract';

const mocks = vi.hoisted(() => ({ db: null as unknown, send: vi.fn(), operator: vi.fn() }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/www'), get db() { return mocks.db; },
}));
vi.mock('@imajin/notify', () => ({ notify: { send: mocks.send } }));
vi.mock('@/src/lib/notify/operator-approvals', () => ({ getOperatorDid: mocks.operator }));
import { listAlphaSubmissions, storeAlphaSubmission } from '../store';

const pg = new PGlite();
const database = drizzle(pg);
const valid = { name: 'Example Person', email: 'person@example.com', company: 'Example', purpose: 'Book travel.' };
vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });
beforeAll(async () => {
  mocks.db = database;
  const migration = readFileSync(resolve('migrations/0238_alpha_submissions.sql'), 'utf8');
  await pg.exec(migration);
  await pg.exec(migration);
});
beforeEach(() => { vi.clearAllMocks(); mocks.operator.mockResolvedValue('operator'); mocks.send.mockResolvedValue(undefined); });
afterAll(async () => { await pg.close(); });

describe('alpha migration and store', () => {
  it('maps bounded columns, defaults and indexes to the idempotent SQL migration', async () => {
    const config = getTableConfig(alphaSubmissions);
    expect(config.schema).toBe('www');
    expect(config.name).toBe('alpha_submissions');
    expect(config.indexes.map(index => index.config.name)).toEqual(['idx_alpha_submissions_created', 'idx_alpha_submissions_intent_created']);
    expect(config.checks.map(check => check.name)).toEqual(['alpha_submissions_intent_check']);
    expect(alphaSubmissions.id.primary).toBe(true);
    expect(config.columns.every(column => column.notNull)).toBe(true);
    expect(alphaSubmissions.name.getSQLType()).toBe('varchar(120)');
    expect(alphaSubmissions.email.getSQLType()).toBe('varchar(254)');
    expect(alphaSubmissions.company.getSQLType()).toBe('varchar(200)');
    expect(alphaSubmissions.purpose.getSQLType()).toBe('varchar(1000)');
    expect(alphaSubmissions.createdAt.hasDefault).toBe(true);
    const columns = await pg.query<{ column_name: string; character_maximum_length: number }>(
      "SELECT column_name, character_maximum_length FROM information_schema.columns WHERE table_schema='www' AND table_name='alpha_submissions'",
    );
    expect(columns.rows).toContainEqual(expect.objectContaining({ column_name: 'purpose', character_maximum_length: 1000 }));
  });
  it('persists each intent and notifies only the configured operator without any submitted content', async () => {
    for (const intent of ALPHA_INTENTS) await storeAlphaSubmission({ ...valid, intent });
    const page = await listAlphaSubmissions(undefined, 0);
    expect(page.submissions).toHaveLength(4);
    expect(page.hasMore).toBe(false);
    expect(mocks.send).toHaveBeenCalledTimes(4);
    for (const [notification] of mocks.send.mock.calls) {
      expect(notification).toEqual({
        to: 'operator', scope: 'alpha.submitted', title: 'New alpha request',
        body: 'A new alpha request is available on /jin.', data: { url: '/jin#alpha-submissions' },
      });
    }
    expect(JSON.stringify(mocks.send.mock.calls)).not.toContain(valid.email);
    expect(JSON.stringify(mocks.send.mock.calls)).not.toContain(valid.purpose);
  });
  it('orders by newest timestamp then ID, filters all intents and paginates without discarding history', async () => {
    await database.insert(alphaSubmissions).values(Array.from({ length: 53 }, (_, index) => ({
      ...valid, company: `page-${index}`, intent: 'demo' as const,
      createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, index)),
    })));
    const first = await listAlphaSubmissions('demo', 0);
    expect(first.submissions).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(first.submissions[0].company).toBe('page-52');
    expect(first.submissions.at(-1)?.company).toBe('page-3');
    const next = await listAlphaSubmissions('demo', 50);
    expect(next.submissions).toHaveLength(4);
    expect(next.hasMore).toBe(false);
    expect(next.submissions[0].company).toBe('page-2');
    for (const intent of ALPHA_INTENTS) {
      const filtered = await listAlphaSubmissions(intent, 0);
      expect(filtered.submissions.every(row => row.intent === intent)).toBe(true);
      expect(filtered.submissions.length).toBeGreaterThan(0);
    }
  });
  it('preserves a stored request through notification failures or missing operator configuration', async () => {
    mocks.send.mockRejectedValue(new Error('notification offline'));
    await expect(storeAlphaSubmission({ ...valid, company: 'notify-failed', intent: 'tester' })).resolves.toBeUndefined();
    mocks.operator.mockResolvedValue(null);
    await storeAlphaSubmission({ ...valid, company: 'unconfigured', intent: 'tester' });
    expect(mocks.send).toHaveBeenCalledOnce();
    const page = await listAlphaSubmissions('tester', 0);
    expect(page.submissions.some(row => row.company === 'notify-failed')).toBe(true);
    expect(page.submissions.some(row => row.company === 'unconfigured')).toBe(true);
  });
  it('keeps database constraints when a caller bypasses validation', async () => {
    for (const values of [{ ...valid, intent: 'signup' }, { ...valid, intent: 'tester', purpose: 'x'.repeat(1001) }]) {
      await expect(database.insert(alphaSubmissions).values(values as typeof alphaSubmissions.$inferInsert)).rejects.toThrow();
    }
  });
});
