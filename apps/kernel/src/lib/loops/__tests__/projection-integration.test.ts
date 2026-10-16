import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@imajin/db', () => ({ getClient: () => sql }));
import { loopProjectionReactor } from '../../../../../../packages/bus/src/reactors/loop-projection';
import type { BusEvent } from '../../../../../../packages/bus/src/types';

const pg = new PGlite();
beforeAll(async () => {
  await pg.exec(`CREATE SCHEMA kernel;
    CREATE TABLE kernel.bus_chain_configs (
      event_type text, scope text, reactors jsonb, enabled boolean, updated_at timestamptz,
      UNIQUE(event_type, scope)
    );`);
  await pg.exec(readFileSync(new URL('../../../../../../migrations/0157_loops_rail.sql', import.meta.url), 'utf8'));
  sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((result, part, index) => result + (index ? `$${index}` : '') + part, '');
    return (await pg.query(text, values)).rows;
  });
}, 30_000);
afterAll(() => pg.close());

const principal = 'did:imajin:owner';
async function project(type: string, at: string, refs?: Record<string, string>) {
  const event: BusEvent = {
    type, issuer: 'did:imajin:node', subject: principal, scope: 'loop',
    payload: { loopId: 'run', kind: 'warp.run', principal, state: type, summary: type, at, ...(refs ? { refs } : {}) },
  };
  await loopProjectionReactor(event, {});
}

describe('real loop projection SQL', () => {
  it('preserves issue/PR refs across sparse progress, resume session changes and timeout, ignoring stale refs', async () => {
    const issue = 'https://github.com/o/r/issues/1';
    const pr = 'https://github.com/o/r/pull/2';
    await project('loop.started', '2026-10-16T00:00:00Z', { runId: 'run', sessionKey: 'first', issue, pr });
    await project('loop.progress', '2026-10-16T00:01:00Z');
    await project('loop.finished', '2026-10-16T00:01:15Z');
    await project('loop.started', '2026-10-16T00:02:00Z', { sessionKey: 'resumed' });
    const resumed = await pg.query<{ finished_at: string | null }>('SELECT finished_at FROM kernel.loops');
    expect(resumed.rows[0].finished_at).toBeNull();
    await project('loop.finished', '2026-10-16T00:03:00Z', { runId: 'run' });
    await project('loop.progress', '2026-10-16T00:01:30Z', { issue: 'stale', sessionKey: 'stale' });
    const { rows } = await pg.query<{ refs: Record<string, string>; state: string }>('SELECT refs, state FROM kernel.loops');
    expect(rows).toEqual([{ refs: { runId: 'run', sessionKey: 'resumed', issue, pr }, state: 'loop.finished' }]);
    const history = await pg.query<{ count: number }>('SELECT count(*)::int AS count FROM kernel.loop_events');
    expect(history.rows[0].count).toBe(6);
  });
});
