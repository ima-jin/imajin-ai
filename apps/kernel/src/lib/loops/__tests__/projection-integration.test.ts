import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@imajin/db', () => ({ getClient: () => sql }));
import { loopProjectionReactor, LoopOwnershipConflictError } from '../../../../../../packages/bus/src/reactors/loop-projection';
import type { BusEvent } from '../../../../../../packages/bus/src/types';
import { getLoopWithHistory } from '../query';
import { STEP_ISSUE, STEP_ISSUE_UPDATE, queuedStep, stepEvent, closureStep, releaseStep, deployedStep } from './horizon-fixtures';

const pg = new PGlite();
function taggedSql(executor: Pick<PGlite, 'query'>) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((result, part, index) => result + (index ? `$${index}` : '') + part, '');
    return (await executor.query(text, values)).rows;
  };
}
beforeAll(async () => {
  await pg.exec(`CREATE SCHEMA kernel;
    CREATE TABLE kernel.bus_chain_configs (
      event_type text, scope text, reactors jsonb, enabled boolean, updated_at timestamptz,
      UNIQUE(event_type, scope)
    );`);
  await pg.exec(readFileSync(new URL('../../../../../../migrations/0157_loops_rail.sql', import.meta.url), 'utf8'));
  await pg.exec(readFileSync(new URL('../../../../../../migrations/0194_surface_lease.sql', import.meta.url), 'utf8'));
  sql.mockImplementation(taggedSql(pg));
  Object.assign(sql, {
    begin: (work: (tx: ReturnType<typeof taggedSql>) => Promise<void>) =>
      pg.transaction(tx => work(taggedSql(tx))),
  });
}, 30_000);
afterAll(() => pg.close());

const principal = 'did:imajin:owner';
async function project(type: string, at: string, refs?: Record<string, string>, extra: Record<string, unknown> = {}) {
  const event: BusEvent = {
    type, issuer: 'did:imajin:node', subject: principal, scope: 'loop',
    payload: { loopId: 'run', kind: 'warp.run', principal, state: type, summary: type, at, ...(refs ? { refs } : {}), ...extra },
  };
  await loopProjectionReactor(event, {});
}

describe('real loop projection SQL', () => {
  it('persists ref-only bindings and rebuilds closure/release/deploy conditions without an invented OUTCOME', async () => {
    const queue = queuedStep();
    const owner = queue.principal;
    const loopId = 'ref-only-binding';
    await project('loop.started', queue.occurredAt, undefined, { loopId, principal: owner });
    const persist = async (event: ReturnType<typeof stepEvent>) =>
      loopProjectionReactor({
        ...event, id: `${loopId}:${event.id}`, loopId, payload: { ...event.payload, loopId }, subject: owner, scope: 'loop',
      }, {});
    const facts = [
      queue,
      stepEvent('step.updated', 1, { update: { issue: { ref: STEP_ISSUE } } }),
      stepEvent('step.finished', 2),
      closureStep(),
    ];
    for (const event of facts) await persist(event);
    const beforeRestart = await getLoopWithHistory(loopId, owner);
    expect(beforeRestart?.horizon).toMatchObject({ depth: 1, steps: [{
      issue: { ref: STEP_ISSUE }, state: 'finished', zone: 'past', openExitConditions: ['released', 'prod'],
    }] });
    expect(beforeRestart?.horizon.steps[0].conditions.map(condition => condition.satisfied)).toEqual([true, false, false]);
    const persistedUpdate = beforeRestart?.events.find(event => event.type === 'step.updated');
    expect(persistedUpdate?.payload.update).toEqual({ issue: { ref: STEP_ISSUE } });
    expect(persistedUpdate?.payload).toEqual({ ...facts[1].payload, loopId });
    expect(beforeRestart?.horizon.steps[0].issue).not.toHaveProperty('outcome');
    sql.mockImplementation(taggedSql(pg));
    expect((await getLoopWithHistory(loopId, owner))?.horizon).toEqual(beforeRestart?.horizon);
    await persist(releaseStep());
    expect((await getLoopWithHistory(loopId, owner))?.horizon.steps[0].openExitConditions).toEqual(['prod']);
    await persist(deployedStep());
    expect((await getLoopWithHistory(loopId, owner))?.horizon.depth).toBe(0);
    const audit = await getLoopWithHistory(loopId, owner, true);
    expect(audit?.horizon.steps[0]).toMatchObject({
      issue: { ref: STEP_ISSUE }, state: 'exited', zone: 'done', openExitConditions: [],
    });
    expect(audit?.horizon.steps[0].issue).not.toHaveProperty('outcome');
    expect(audit?.loop.state).toBe('loop.started');
  });
  it('persists and rebuilds ranked horizon facts, deduplicates retry, and keeps the parent lifecycle unchanged', async () => {
    const queue = queuedStep();
    const owner = queue.principal;
    await project('loop.started', queue.occurredAt, undefined, { loopId: 'cycle', principal: owner });
    const steps = [queue, stepEvent('step.updated', 1, { update: STEP_ISSUE_UPDATE }), closureStep(), releaseStep()];
    for (const event of [...steps].reverse()) {
      await loopProjectionReactor({ ...event, subject: owner, scope: 'loop' }, {});
    }
    await loopProjectionReactor({ ...queue, subject: owner, scope: 'loop' }, {});
    const beforeRestart = await getLoopWithHistory('cycle', owner);
    expect(beforeRestart?.horizon).toMatchObject({ depth: 1, steps: [{ zone: 'past', openExitConditions: ['prod'] }] });
    expect(beforeRestart?.loop.state).toBe('loop.started');
    expect(beforeRestart?.events.filter(event => event.type === 'step.queued')).toHaveLength(1);
    // Recreate the SQL client: no per-agent or in-memory projection survives.
    sql.mockImplementation(taggedSql(pg));
    expect((await getLoopWithHistory('cycle', owner))?.horizon).toEqual(beforeRestart?.horizon);
    expect(await getLoopWithHistory('cycle', 'did:imajin:someone-else', true)).toBeNull();
    const deployed = deployedStep();
    await loopProjectionReactor({ ...deployed, subject: owner, scope: 'loop' }, {});
    expect((await getLoopWithHistory('cycle', owner))?.horizon.depth).toBe(0);
    const audit = await getLoopWithHistory('cycle', owner, true);
    expect(audit?.horizon.steps[0]).toMatchObject({ state: 'exited', zone: 'done', openExitConditions: [] });
    expect(audit?.events.filter(event => event.type.startsWith('step.'))).toHaveLength(5);
    const foreign = { ...queue, id: 'foreign-step', principal: 'did:imajin:other', payload: { ...queue.payload, principal: 'did:imajin:other' }, subject: 'did:imajin:other', scope: 'loop' };
    await expect(loopProjectionReactor(foreign, {})).rejects.toBeInstanceOf(LoopOwnershipConflictError);
  });
  it('does not let another principal overwrite a globally unique loop id', async () => {
    await project('loop.started', '2026-10-16T00:00:00Z', { issue: 'original' }, { loopId: 'collision' });
    await expect(project('loop.finished', '2026-10-16T00:01:00Z', { issue: 'hostile' }, { loopId: 'collision', principal: 'did:imajin:other' }))
      .rejects.toBeInstanceOf(LoopOwnershipConflictError);
    const current = await pg.query('SELECT principal, refs, state FROM kernel.loops WHERE loop_id = $1', ['collision']);
    expect(current.rows).toEqual([{ principal, refs: { issue: 'original' }, state: 'loop.started' }]);
    const foreignHistory = await pg.query('SELECT principal FROM kernel.loop_events WHERE loop_id = $1 AND principal = $2', ['collision', 'did:imajin:other']);
    expect(foreignHistory.rows).toEqual([]);
  });
  it('inserts the first PR artifact once and retains lineage when provider state arrives', async () => {
    const extra = { loopId: 'pr:first', kind: 'pr', parentLoopId: 'source-run', state: 'artifact-observed', initialObservation: true };
    await project('loop.started', '2026-10-16T00:00:00Z', { pr: 'https://github.com/o/r/pull/1' }, extra);
    await project('loop.finished', '2026-10-16T00:01:00Z', undefined, { loopId: 'pr:first', kind: 'pr', state: 'merged' });
    // Simulates a provider observation winning after the existence check but
    // before a delayed artifact insert. The artifact must not regress it.
    await project('loop.started', '2026-10-16T00:02:00Z', undefined, { ...extra, parentLoopId: 'different-run' });
    const current = await pg.query('SELECT state, parent_loop_id FROM kernel.loops WHERE loop_id = $1', ['pr:first']);
    expect(current.rows).toEqual([{ state: 'merged', parent_loop_id: 'source-run' }]);
  });
  it('preserves issue/PR refs across sparse progress, resume session changes and timeout, ignoring stale refs', async () => {
    const issue = 'https://github.com/o/r/issues/1';
    const pr = 'https://github.com/o/r/pull/2';
    await project('loop.started', '2026-10-16T00:00:00Z', { runId: 'run', sessionKey: 'first', issue, pr });
    await project('loop.progress', '2026-10-16T00:01:00Z');
    await project('loop.finished', '2026-10-16T00:01:15Z');
    await project('loop.started', '2026-10-16T00:02:00Z', { sessionKey: 'resumed' });
    const resumed = await pg.query<{ finished_at: string | null }>('SELECT finished_at FROM kernel.loops WHERE loop_id = $1', ['run']);
    expect(resumed.rows[0].finished_at).toBeNull();
    await project('loop.finished', '2026-10-16T00:03:00Z', { runId: 'run' });
    await project('loop.progress', '2026-10-16T00:01:30Z', { issue: 'stale', sessionKey: 'stale' });
    const { rows } = await pg.query<{ refs: Record<string, string>; state: string }>('SELECT refs, state FROM kernel.loops WHERE loop_id = $1', ['run']);
    expect(rows).toEqual([{ refs: { runId: 'run', sessionKey: 'resumed', issue, pr }, state: 'loop.finished' }]);
    const history = await pg.query<{ count: number }>('SELECT count(*)::int AS count FROM kernel.loop_events WHERE loop_id = $1', ['run']);
    expect(history.rows[0].count).toBe(6);
  });
});
