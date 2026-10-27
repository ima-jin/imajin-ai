/**
 * Opt in with WARP_USAGE_TEST_DATABASE_URL targeting a local PostgreSQL admin
 * database. Creates an isolated database, never writes to the supplied DB.
 * Uses postgres-js unchanged: unlike the PGlite shim, no Date-to-string rewrite.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeAgentRun } from './run-fixture';

const h = vi.hoisted(() => ({
  client: undefined as ReturnType<typeof postgres> | undefined,
  getRun: vi.fn(), list: vi.fn(), publish: vi.fn(),
  rootBindings: vi.fn(),
  log: { warn: vi.fn() },
}));
vi.mock('@imajin/db', () => ({ getClient: () => h.client! }));
vi.mock('@imajin/logger', () => ({ createLogger: () => h.log }));
vi.mock('../dispatch', () => ({ getAgentRun: h.getRun, listAgentRuns: h.list }));
vi.mock('@/src/lib/inference/usage-ledger', () => ({ publishUsageIncurred: h.publish }));
import { sweepWarpIncurredUsage, WARP_USAGE_SETTLE_MS } from '../usage-sweep';
import { WARP_INCURRED_SINCE } from '../../usage/warp-incurred';

const adminUrl = process.env.WARP_USAGE_TEST_DATABASE_URL;
const OWNER = 'did:imajin:owner';
const NOW = '2026-10-27T12:00:00.000Z';
const migrations = resolve(__dirname, '../../../../../../migrations/archive/pre-kernel-baseline');
let admin: ReturnType<typeof postgres> | undefined;

describe.skipIf(!adminUrl)('Warp sweep — real PostgreSQL parameter types (#3133)', () => {
  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('WARP_USAGE_TEST_DATABASE_URL must target local disposable PostgreSQL');
    }
    admin = postgres(adminUrl!, { max: 1, connect_timeout: 5 });
    const name = `warp_usage_test_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    h.client = postgres(url.toString(), {
      max: 1, connect_timeout: 5, onnotice: () => {},
      debug: (_connection, query, parameters) => {
        if (query.includes('WITH roots AS')) h.rootBindings(parameters);
      },
    });
    await h.client.unsafe(`CREATE SCHEMA kernel; CREATE SCHEMA registry;
      CREATE TABLE registry.node_config(key text PRIMARY KEY, value jsonb);
      CREATE TABLE kernel.bus_chain_configs
        (event_type text, scope text, reactors jsonb, enabled boolean, updated_at timestamptz,
         UNIQUE NULLS NOT DISTINCT(event_type, scope));`);
    for (const migration of [
      '0103_event_subscription_log.sql', '0119_usage_incurred.sql',
      '0120_usage_incurred_quantity.sql', '0121_usage_emitters.sql',
      '0157_loops_rail.sql', '0214_usage_incurred_pricing.sql',
    ]) {
      await h.client.unsafe(readFileSync(resolve(migrations, migration), 'utf8'));
    }
    h.publish.mockResolvedValue(undefined);
    h.list.mockResolvedValue({ runs: [], hasNextPage: false, nextCursor: null });
  }, 30_000);

  afterAll(async () => {
    await h.client?.end();
    await admin?.end();
  });

  it('rejects a text-serialized Date while explicit ISO text preserves the boundary', async () => {
    const sql = h.client!;
    const date = new Date(new Date(NOW).getTime() - WARP_USAGE_SETTLE_MS);
    // The production query's default Date binding succeeds locally. This
    // isolates the suspected *text-typed* parameter failure, not proof that
    // production selected that serializer.
    await expect(sql`SELECT ${sql.typed(date, 25)}::timestamptz`).rejects.toThrow('invalid input syntax for type timestamp with time zone');
    const [row] = await sql`SELECT ${sql.typed(date.toISOString(), 25)}::timestamptz AS boundary`;
    expect(row.boundary.toISOString()).toBe('2026-10-26T12:00:00.000Z');
  });

  it('backfills each terminal run once, joins warp.run loops and stays warning-free across 24h of ticks', async () => {
    const sql = h.client!;
    const root = makeAgentRun({
      runId: 'root', createdAt: WARP_INCURRED_SINCE,
      requestUsage: { inferenceCost: 6000, computeCost: 400, platformCost: 100 },
    });
    const child = { ...root, runId: 'child', parentRunId: root.runId, state: 'FAILED' };
    const legacy = { ...root, runId: 'legacy' };
    h.getRun.mockImplementation(async (_principal: string, runId: string) => runId === legacy.runId ? legacy : root);
    h.list.mockResolvedValue({ runs: [child], hasNextPage: false, nextCursor: null });
    for (const run of [root, child, legacy]) {
      await sql`
        INSERT INTO kernel.loops
          (loop_id, kind, principal, refs, state, summary, last_event_type, started_at, last_seen_at)
        VALUES (${`warp:${run.runId}`}, 'warp.run', ${OWNER}, ${sql.json({ runId: run.runId })},
          'done', 'fixture', 'loop.completed', ${run.createdAt}::timestamptz, ${NOW}::timestamptz)
      `;
    }
    // Root has a durable terminal payload, legacy has only a dispatch, and
    // child is discoverable only through the root's descendant API page.
    for (const [id, eventType, payload] of [
      ['dispatch', 'warp.agent.dispatched', root],
      ['terminal', 'warp.run.completed', root],
      ['legacy', 'warp.agent.dispatched', { runId: legacy.runId }],
      ['pre-cutoff', 'warp.agent.dispatched', { runId: 'too-old' }],
    ] as const) {
      await sql`
        INSERT INTO kernel.event_subscription_log
          (id, event_type, issuer_did, subject_did, scope, payload, occurred_at)
        VALUES (${id}, ${eventType}, ${OWNER}, ${OWNER}, 'warp:dispatch', ${sql.json(payload)},
          ${id === 'terminal' ? NOW : id === 'pre-cutoff' ? '2026-10-18T23:59:59.999Z' : WARP_INCURRED_SINCE}::timestamptz)
      `;
    }
    // No deletes or manual usage inserts: every row comes through the sweep.
    for (let hour = 0; hour <= 24; hour++) {
      await sweepWarpIncurredUsage(new Date(new Date(NOW).getTime() + hour * 3_600_000));
    }
    const rows = await sql`
      SELECT l.refs->>'runId' AS run_id, COUNT(u.id)::int AS meters,
             MIN(u.unit) AS unit, MIN(u.quantity)::text AS credits, MIN(u.cost_usd)::text AS usd
      FROM kernel.loops l LEFT JOIN usage.incurred u
        ON u.external_id = l.refs->>'runId' AND u.principal_did = l.principal AND u.source = 'adapter:warp'
      WHERE l.kind = 'warp.run' AND l.principal = ${OWNER}
      GROUP BY l.loop_id, l.refs->>'runId' ORDER BY run_id
    `;
    expect(rows.map(row => ({ ...row }))).toEqual(['child', 'legacy', 'root'].map(runId => ({
      run_id: runId, meters: 1, unit: 'warp-credits', credits: '6500.000000', usd: '100.00000000',
    })));
    expect(await sql`SELECT id FROM usage.incurred`).toHaveLength(3);
    expect(h.publish).toHaveBeenCalledTimes(3);
    expect(h.getRun).not.toHaveBeenCalledWith(OWNER, 'too-old');
    expect(h.getRun).toHaveBeenCalledWith(OWNER, 'legacy');
    expect(h.rootBindings).toHaveBeenCalledTimes(25);
    for (const [parameters] of h.rootBindings.mock.calls) {
      expect(parameters).toEqual([WARP_INCURRED_SINCE, 'adapter:warp', expect.any(String)]);
    }
    expect(h.log.warn).not.toHaveBeenCalled();
  }, 30_000);
});
