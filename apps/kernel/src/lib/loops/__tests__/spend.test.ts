import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@imajin/db', () => ({ getClient: () => sql }));
import { readRegistrySpend, registeredRunIds, unregisteredSessionIds } from '../spend';

const principal = 'did:imajin:operator';
const from = '2026-10-01T00:00:00Z';
const to = '2026-11-01T00:00:00Z';
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA kernel; CREATE SCHEMA usage;
    CREATE TABLE kernel.loops (
      loop_id text PRIMARY KEY, principal text, kind text, refs jsonb,
      summary text DEFAULT 'run', state text DEFAULT 'running',
      started_at timestamptz DEFAULT '2026-10-02', last_seen_at timestamptz DEFAULT '2026-10-03'
    );
    CREATE TABLE usage.incurred (
      id text PRIMARY KEY, principal_did text, session_id text, cost_usd numeric,
      status text, created_at timestamptz DEFAULT '2026-10-04'
    );
  `);
  const migration = readFileSync('migrations/0192_loop_refs_spend.sql', 'utf8');
  await pg.exec(migration);
  await pg.exec(migration);
  sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((text, part, i) => text + (i ? `$${i}` : '') + part, '');
    const params = values.map((value) => Array.isArray(value) ? `{${value.join(',')}}` : value);
    return (await pg.query(query, params)).rows;
  });
});
afterAll(async () => { await pg.close(); });
beforeEach(async () => { await pg.exec('TRUNCATE kernel.loops, usage.incurred'); });

async function loop(id: string, runId: string, sessionKey?: string, extra: Record<string, unknown> = {}, owner = principal) {
  await pg.query(`INSERT INTO kernel.loops(loop_id, principal, kind, refs) VALUES ($1,$2,$3,$4)`,
    [id, owner, id.startsWith('review') ? 'review' : 'warp.run', JSON.stringify({ runId, sessionKey, ...extra })]);
}
async function usage(id: string, session: string | null, cost: number | null, owner = principal, at = '2026-10-04', status: string | null = null) {
  await pg.query('INSERT INTO usage.incurred VALUES ($1,$2,$3,$4,$5,$6)', [id, owner, session, cost, status, at]);
}

describe('registry usage join', () => {
  it('reserves registry sessions from fallback without leaking another principal', async () => {
    await loop('run1', 'r1', 's1');
    await loop('other', 'r2', 's2', {}, 'did:imajin:other');
    expect((await unregisteredSessionIds(principal, ['r1', 's1', 's2', 'legacy'])).sort()).toEqual(['legacy', 's2']);
    expect(await unregisteredSessionIds(principal, [])).toEqual([]);
  });
  it('joins both runId and sessionKey, deduplicates duplicate loops and groups issues/PRs', async () => {
    await loop('run1', 'r1', 's1', { issue: 'o/repo#1', pr: 'o/repo#2' });
    await loop('review1', 'r1', 's1');
    await loop('run2', 'r2', 's2', { issue: 'o/repo#1', pr: 'o/repo#2' });
    await usage('u1', 'r1', 2);
    await usage('u2', 's1', 3);
    await usage('u3', 's2', 4);
    const result = await readRegistrySpend(principal, from, to);
    expect(result.runs).toHaveLength(2);
    expect(result.runs.find((r) => r.runId === 'r1')?.metered).toEqual({ usd: 5, turns: 2 });
    expect(result.issues).toEqual([{ ref: 'o/repo#1', runCount: 2, meteredUsd: 9 }]);
    expect(result.prs).toEqual([{ ref: 'o/repo#2', runCount: 2, meteredUsd: 9 }]);
  });

  it('does not assign a shared session to multiple runs; exact run id wins an alias collision', async () => {
    await loop('run1', 'r1', 'shared');
    await loop('run2', 'r2', 'shared');
    await loop('run3', 'r3', 'r1');
    await usage('ambiguous', 'shared', 50);
    await usage('exact', 'r1', 2);
    const result = await readRegistrySpend(principal, from, to);
    expect(result.runs.find((r) => r.runId === 'r1')?.metered).toEqual({ usd: 2, turns: 1 });
    expect(result.runs.filter((r) => r.metered !== null)).toHaveLength(1);
  });

  it('isolates both principals and the half-open usage window; excludes errors', async () => {
    await loop('run1', 'r1', 's1');
    await loop('other', 'r2', 's1', {}, 'did:imajin:other');
    await usage('own', 's1', 1);
    await usage('other-owner', 's1', 90, 'did:imajin:other');
    await usage('before', 's1', 90, principal, '2026-09-30');
    await usage('boundary', 's1', 90, principal, to);
    await usage('error', 's1', 90, principal, '2026-10-04', 'error');
    await usage('unlinked', null, 90);
    const result = await readRegistrySpend(principal, from, to);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].metered).toEqual({ usd: 1, turns: 1 });
  });

  it('preserves unknown versus zero costs and includes old loops with current usage', async () => {
    await loop('run1', 'r1', undefined, { issue: 'o/r#1' });
    await loop('run2', 'r2', undefined, { issue: 'o/r#2' });
    await loop('run3', 'r3', undefined, { issue: 'o/r#3' });
    await pg.exec(`UPDATE kernel.loops SET started_at='2026-09-01', last_seen_at='2026-09-02' WHERE loop_id='run1'`);
    await usage('unknown', 'r1', null);
    await usage('zero', 'r2', 0);
    const result = await readRegistrySpend(principal, from, to);
    expect(result.runs.find((r) => r.runId === 'r1')?.metered).toEqual({ usd: null, turns: 1 });
    expect(result.runs.find((r) => r.runId === 'r2')?.metered).toEqual({ usd: 0, turns: 1 });
    expect(result.runs.find((r) => r.runId === 'r3')?.metered).toBeNull();
    expect(result.issues.map((i) => i.meteredUsd)).toEqual([null, 0, null]);
  });

  it('checks membership outside list windows, and returns empty without querying for no ids', async () => {
    await loop('run1', 'r1');
    await loop('other', 'r2', undefined, {}, 'did:imajin:other');
    expect(await registeredRunIds(principal, ['r1', 'r2'])).toEqual(new Set(['r1']));
    const count = sql.mock.calls.length;
    expect(await registeredRunIds(principal, [])).toEqual(new Set());
    expect(sql.mock.calls).toHaveLength(count);
  });
});
