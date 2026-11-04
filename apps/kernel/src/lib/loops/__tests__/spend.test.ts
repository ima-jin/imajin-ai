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
    CREATE TABLE kernel.loop_events (loop_id text, principal text, payload jsonb, type text DEFAULT 'loop.started');
  `);
  const migration = readFileSync('migrations/archive/pre-kernel-baseline/0192_loop_refs_spend.sql', 'utf8');
  await pg.exec(migration);
  await pg.exec(migration);
  sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((text, part, i) => text + (i ? `$${i}` : '') + part, '');
    const params = values.map((value) => Array.isArray(value) ? `{${value.join(',')}}` : value);
    return (await pg.query(query, params)).rows;
  });
});
afterAll(async () => { await pg.close(); });
beforeEach(async () => { await pg.exec('TRUNCATE kernel.loops, kernel.loop_events, usage.incurred'); });

async function loop(id: string, runId: string, sessionKey?: string, extra: Record<string, unknown> = {}, owner = principal) {
  await pg.query(`INSERT INTO kernel.loops(loop_id, principal, kind, refs) VALUES ($1,$2,$3,$4)`,
    [id, owner, id.startsWith('review') ? 'review' : 'warp.run', JSON.stringify({ runId, sessionKey, ...extra })]);
}
async function usage(id: string, session: string | null, cost: number | null, owner = principal, at = '2026-10-04', status: string | null = null) {
  await pg.query('INSERT INTO usage.incurred VALUES ($1,$2,$3,$4,$5,$6)', [id, owner, session, cost, status, at]);
}

describe('registry usage join', () => {
  it('uses unique signed subject refs across a run, without guessing among conflicting refs', async () => {
    await loop('run1', 'r1');
    await loop('review1', 'r1', undefined, { issue: 'o/r#9', pr: 'o/r#10' });
    await usage('u1', 'r1', 2);
    let result = await readRegistrySpend(principal, from, to);
    expect(result.issues).toEqual([{ ref: 'o/r#9', runCount: 1, meteredUsd: 2 }]);
    await loop('review2', 'r1', undefined, { issue: 'o/r#11' });
    result = await readRegistrySpend(principal, from, to);
    expect(result.issues).toEqual([]);
    expect(result.runs[0].metered?.usd).toBe(2);
    expect(result.prs).toEqual([{ ref: 'o/r#10', runCount: 1, meteredUsd: 2 }]);
  });
  it('includes previous signed run ids after a resume, without cross-principal aliases', async () => {
    await loop('run1', 'r1', 'new-session');
    await pg.query('INSERT INTO kernel.loop_events(loop_id,principal,payload) VALUES ($1,$2,$3), ($1,$4,$5)', [
      'run1', principal, JSON.stringify({ refs: { runId: 'old-run', sessionKey: 'old-session' } }),
      'did:imajin:other', JSON.stringify({ refs: { runId: 'foreign' } }),
    ]);
    await usage('old', 'old-run', 2);
    await usage('new', 'r1', 3);
    await usage('legacy-old', 'old-session', 90);
    await usage('legacy-new', 'new-session', 90);
    await usage('foreign', 'foreign', 90);
    const result = await readRegistrySpend(principal, from, to);
    expect(result.runs[0].metered).toEqual({ usd: 5, turns: 2 });
    expect(result.runs[0].refs).toEqual({ runId: 'r1' });
    expect(await unregisteredSessionIds(principal, ['old-run', 'foreign', 'old-session'])).toEqual(['foreign', 'old-session']);
  });
  it('correlates legacy loops only through their stable loop id, ignoring historical harness keys', async () => {
    await pg.query(`INSERT INTO kernel.loops(loop_id, principal, kind, refs) VALUES ('session-loop', $1, 'openclaw.subagent', $2)`,
      [principal, JSON.stringify({ sessionKey: 'session-only', issue: 'o/r#9' })]);
    await usage('u1', 'session-loop', 2);
    await usage('historical', 'session-only', 90);
    const result = await readRegistrySpend(principal, from, to);
    expect(result.runs[0]).toMatchObject({ runId: 'session-loop', loopId: 'session-loop', metered: { usd: 2, turns: 1 } });
    expect(result.issues).toEqual([{ ref: 'o/r#9', runCount: 1, meteredUsd: 2 }]);
    expect(await registeredRunIds(principal, ['session-loop'])).toEqual(new Set(['session-loop']));
  });

  it('aliases a resumed signed run through parentLoopId without a harness key', async () => {
    await loop('parent-loop', 'parent-run');
    await pg.query('INSERT INTO kernel.loop_events(loop_id,principal,payload) VALUES ($1,$2,$3)', [
      'resumed-loop', principal, JSON.stringify({ parentLoopId: 'parent-loop', refs: { runId: 'resumed-run' } }),
    ]);
    await usage('resumed', 'resumed-run', 4);
    expect((await readRegistrySpend(principal, from, to)).runs[0].metered).toEqual({ usd: 4, turns: 1 });
    expect(await unregisteredSessionIds(principal, ['resumed-run'])).toEqual([]);
    // Once the child has its own projection, its exact run id wins.
    await loop('resumed-loop', 'resumed-run');
    const result = await readRegistrySpend(principal, from, to);
    expect(result.runs.find(run => run.runId === 'parent-run')?.metered).toBeNull();
    expect(result.runs.find(run => run.runId === 'resumed-run')?.metered).toEqual({ usd: 4, turns: 1 });
  });

  it('does not use non-lifecycle events as run alias assertions', async () => {
    await loop('run1', 'r1');
    await pg.query('INSERT INTO kernel.loop_events VALUES ($1,$2,$3,$4)', [
      'run1', principal, JSON.stringify({ refs: { runId: 'not-a-run' } }), 'loop.command.queued',
    ]);
    await usage('untrusted', 'not-a-run', 90);
    expect((await readRegistrySpend(principal, from, to)).runs[0].metered).toBeNull();
    expect(await unregisteredSessionIds(principal, ['not-a-run'])).toEqual(['not-a-run']);
  });

  it('never presents partially known run or subject costs as complete', async () => {
    await loop('run1', 'r1', undefined, { issue: 'o/r#9' });
    await loop('run2', 'r2', undefined, { issue: 'o/r#9' });
    await usage('known1', 'r1', 2);
    await usage('unknown1', 'r1', null);
    await usage('known2', 'r2', 3);
    const result = await readRegistrySpend(principal, from, to);
    expect(result.runs.find((r) => r.runId === 'r1')?.metered).toEqual({ usd: null, turns: 2 });
    expect(result.issues).toEqual([{ ref: 'o/r#9', runCount: 2, meteredUsd: null }]);
  });
  it('reserves registry sessions from fallback without leaking another principal', async () => {
    await loop('run1', 'r1', 's1');
    await loop('other', 'r2', 's2', {}, 'did:imajin:other');
    expect((await unregisteredSessionIds(principal, ['r1', 'run1', 's1', 's2', 'legacy'])).sort()).toEqual(['legacy', 's1', 's2']);
    expect(await unregisteredSessionIds(principal, [])).toEqual([]);
  });
  it('joins runId and loopId, deduplicates duplicate loops and groups issues/PRs', async () => {
    await loop('run1', 'r1', 's1', { issue: 'o/repo#1', pr: 'o/repo#2' });
    await loop('review1', 'r1', 's1');
    await loop('run2', 'r2', 's2', { issue: 'o/repo#1', pr: 'o/repo#2' });
    await usage('u1', 'r1', 2);
    await usage('u2', 'review1', 3);
    await usage('u3', 'run2', 4);
    const result = await readRegistrySpend(principal, from, to);
    expect(result.runs).toHaveLength(2);
    expect(result.runs.find((r) => r.runId === 'r1')?.metered).toEqual({ usd: 5, turns: 2 });
    expect(result.issues).toEqual([{ ref: 'o/repo#1', runCount: 2, meteredUsd: 9 }]);
    expect(result.prs).toEqual([{ ref: 'o/repo#2', runCount: 2, meteredUsd: 9 }]);
  });

  it('does not assign a shared run alias to multiple runs; exact run id wins an alias collision', async () => {
    await loop('run1', 'r1', 'shared');
    await loop('run2', 'r2', 'shared');
    await loop('run3', 'r3', 'r1');
    for (const [loopId, runId] of [['run1', 'shared'], ['run2', 'shared'], ['run3', 'r1']]) {
      await pg.query('INSERT INTO kernel.loop_events(loop_id,principal,payload) VALUES ($1,$2,$3)',
        [loopId, principal, JSON.stringify({ refs: { runId } })]);
    }
    await usage('ambiguous', 'shared', 50);
    await usage('exact', 'r1', 2);
    const result = await readRegistrySpend(principal, from, to);
    expect(result.runs.find((r) => r.runId === 'r1')?.metered).toEqual({ usd: 2, turns: 1 });
    expect(result.runs.filter((r) => r.metered !== null)).toHaveLength(1);
  });

  it('isolates both principals and the half-open usage window; excludes errors', async () => {
    await loop('run1', 'r1', 's1');
    await loop('other', 'r2', 's1', {}, 'did:imajin:other');
    await usage('own', 'r1', 1);
    await usage('other-owner', 'r1', 90, 'did:imajin:other');
    await usage('before', 'r1', 90, principal, '2026-09-30');
    await usage('boundary', 'r1', 90, principal, to);
    await usage('error', 'r1', 90, principal, '2026-10-04', 'error');
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
