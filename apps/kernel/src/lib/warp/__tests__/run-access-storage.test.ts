import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@imajin/db', () => ({ getClient: () => h.sql }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: () => ({ senderDid: 'did:node' }) }));
import { assertRunAccess, readRunReceipt } from '../run-access';
import { WarpRunAccessError } from '../errors';

// Entirely disposable PostgreSQL semantics; no connection to any kernel/real DB.
const db = new PGlite();
let sequence = 0;
beforeAll(async () => {
  await db.exec(`
    CREATE SCHEMA kernel;
    CREATE TABLE kernel.loops (
      loop_id text PRIMARY KEY, kind text, principal text, parent_loop_id text
    );
    CREATE TABLE kernel.loop_events (
      id text PRIMARY KEY, loop_id text, type text, issuer text, principal text,
      payload jsonb, occurred_at timestamptz
    );
  `);
  h.sql.mockImplementation(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
    return (await db.query(query, values)).rows;
  });
}, 20_000);
afterAll(async () => db.close());

async function seed(runId: string, options: {
  eventId?: string; issuer?: string; type?: string; kind?: string;
  payload?: Record<string, unknown>; parent?: string; at?: string;
} = {}) {
  await db.query(`INSERT INTO kernel.loops VALUES ($1, $2, 'did:org', $3)
    ON CONFLICT DO NOTHING`, [runId, options.kind ?? 'warp.run', options.parent ?? null]);
  const payload = {
    kind: 'warp.run', loopId: runId, principal: 'did:org', actorDid: 'did:actor',
    parentLoopId: options.parent ?? null, refs: { runId }, ...options.payload,
  };
  await db.query(`INSERT INTO kernel.loop_events VALUES ($1, $2, $3, $4, 'did:org', $5, $6)`, [
    options.eventId ?? `signed-loop:${(++sequence).toString(16).padStart(64, '0')}`,
    runId, options.type ?? 'loop.started', options.issuer ?? 'did:node', JSON.stringify(payload),
    options.at ?? '2026-11-04T00:00:00Z',
  ]);
}

describe('signed receipt SQL, real PostgreSQL semantics', () => {
  it('reads the original node-witnessed ingest and permits principal/actor', async () => {
    await seed('owned');
    expect(await readRunReceipt('owned')).toEqual({ principalDid: 'did:org', actorDid: 'did:actor', parentRunId: null });
    await expect(assertRunAccess('did:org', 'owned')).resolves.toBeDefined();
    await expect(assertRunAccess('did:actor', 'owned')).resolves.toBeDefined();
  });
  it.each([
    { eventId: 'unsigned-bus-event' }, { eventId: 'signed-loop:malformed' },
    { issuer: 'did:attacker' }, { type: 'loop.progress' }, { kind: 'not-warp' },
    { payload: { kind: 'not-warp' } }, { payload: { loopId: 'foreign' } },
    { payload: { principal: 'did:foreign' } }, { payload: { refs: { runId: 'foreign' } } },
  ])('refuses a row not bound to the node-signed Warp dispatch: %j', async options => {
    const runId = `invalid-${sequence}`;
    await seed(runId, options);
    expect(await readRunReceipt(runId)).toBeNull();
    await expect(assertRunAccess('did:org', runId)).rejects.toBeInstanceOf(WarpRunAccessError);
  });
  it('refuses projection-only runs and runs with no projection', async () => {
    await db.query("INSERT INTO kernel.loops VALUES ('projection-only', 'warp.run', 'did:org', NULL)");
    expect(await readRunReceipt('projection-only')).toBeNull();
    expect(await readRunReceipt('missing')).toBeNull();
  });
  it('never upgrades legacy principal-only ownership from a later resume or unsigned actor claim', async () => {
    await seed('legacy', { payload: { actorDid: null } });
    await seed('legacy', { payload: { actorDid: 'did:later' }, at: '2026-11-04T01:00:00Z' });
    await seed('legacy', { eventId: 'unsigned-actor', payload: { actorDid: 'did:forged' }, at: '2026-11-03T00:00:00Z' });
    await expect(assertRunAccess('did:org', 'legacy')).resolves.toBeDefined();
    for (const actor of ['did:later', 'did:forged']) {
      await expect(assertRunAccess(actor, 'legacy')).rejects.toBeInstanceOf(WarpRunAccessError);
    }
  });
  it('authorizes ancestor ownership only through matching signed/projected lineage', async () => {
    await seed('ancestor');
    await seed('descendant', { parent: 'ancestor', payload: { actorDid: 'did:bot' } });
    await expect(assertRunAccess('did:actor', 'descendant')).resolves.toBeDefined();
    await expect(assertRunAccess('did:stranger', 'descendant')).rejects.toBeInstanceOf(WarpRunAccessError);
    await seed('grafted', { parent: 'ancestor', payload: { parentLoopId: null, actorDid: 'did:bot' } });
    await expect(assertRunAccess('did:actor', 'grafted')).rejects.toBeInstanceOf(WarpRunAccessError);
  });
});
