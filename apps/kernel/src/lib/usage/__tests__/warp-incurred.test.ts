import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgentRun } from '../../warp/__tests__/run-fixture';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const { getClient, publish, log, getRun, list } = vi.hoisted(() => ({
  getClient: vi.fn(), publish: vi.fn(),
  getRun: vi.fn(), list: vi.fn(),
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('@imajin/db', () => ({ getClient }));
vi.mock('@imajin/logger', () => ({ createLogger: () => log }));
vi.mock('@/src/lib/inference/usage-ledger', () => ({ publishUsageIncurred: publish }));
vi.mock('@/src/lib/warp/dispatch', () => ({ getAgentRun: getRun, listAgentRuns: list }));
import { recordWarpRunUsage, warpRunCredits, WARP_CREDIT_RATE_CONFIG } from '../warp-incurred';
import { sweepWarpIncurredUsage, WARP_USAGE_SETTLE_MS } from '../../warp/usage-sweep';

const OWNER = 'did:imajin:owner';
const CREATED = '2026-10-19T12:00:00.000Z';
const ROOT = resolve(__dirname, '../../../../../../migrations');
let pg: PGlite;
const run = (credits = 6500) => makeAgentRun({
  runId: 'run-a', createdAt: CREATED, modelId: 'actual-model',
  requestUsage: { inferenceCost: credits - 500, computeCost: 400, platformCost: 100 },
});
async function sql(strings: TemplateStringsArray, ...values: unknown[]) {
  const text = strings.reduce((query, part, index) => query + (index ? `$${index}` : '') + part, '');
  return (await pg.query(text, values.map(value => value instanceof Date ? value.toISOString() : value))).rows;
}
async function snapshot() { return (await pg.query('SELECT * FROM usage.incurred ORDER BY external_id')).rows; }
async function setRate(usd: number) {
  await pg.query('INSERT INTO registry.node_config (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',
    [WARP_CREDIT_RATE_CONFIG, JSON.stringify({ usd, credits: 6500 })]);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`CREATE SCHEMA kernel; CREATE TABLE kernel.bus_chain_configs
    (event_type text, scope text, reactors jsonb, enabled boolean, updated_at timestamptz, UNIQUE NULLS NOT DISTINCT(event_type,scope));`);
  for (const name of ['0119_usage_incurred.sql', '0120_usage_incurred_quantity.sql', '0121_usage_emitters.sql', '0214_usage_incurred_pricing.sql']) {
    await pg.exec(readFileSync(resolve(ROOT, name), 'utf8'));
  }
  await pg.exec('CREATE SCHEMA registry; CREATE TABLE registry.node_config(key text PRIMARY KEY,value jsonb)');
  await pg.exec(`CREATE TABLE kernel.event_subscription_log
    (seq bigint GENERATED ALWAYS AS IDENTITY, subject_did text, event_type text, payload jsonb, occurred_at timestamptz DEFAULT now());`);
});
beforeEach(async () => {
  await pg.exec('TRUNCATE usage.incurred,registry.node_config,kernel.event_subscription_log');
  getClient.mockReset().mockReturnValue(Object.assign(sql, { json: (value: unknown) => JSON.stringify(value) }));
  publish.mockReset().mockResolvedValue(undefined);
  log.warn.mockClear();
  getRun.mockReset().mockResolvedValue(run());
  list.mockReset().mockResolvedValue({ runs: [], hasNextPage: false, nextCursor: null });
});
afterAll(async () => { await pg?.close(); });

describe('Warp incurred terminal meter', () => {
  it('fetches only the unsettled root when a thousand settled roots are retained', async () => {
    await pg.query(`
      INSERT INTO usage.incurred(id,principal_did,source,external_id,resource,provider,model,cost_usd,pricing)
      SELECT 'settled-' || n, $1, 'adapter:warp', 'settled-' || n,
             'external:warp/run', 'warp', 'model', 1, '{"credits":65}'::jsonb
      FROM generate_series(1,1000) n
    `, [OWNER]);
    await pg.query(`
      INSERT INTO kernel.event_subscription_log(subject_did,event_type,payload,occurred_at)
      SELECT $1, 'warp.agent.dispatched', jsonb_build_object('runId','settled-' || n), '2026-10-20T00:00:00Z'::timestamptz
      FROM generate_series(1,1000) n
      UNION ALL
      SELECT $1, 'warp.run.completed', jsonb_build_object('runId','settled-' || n), '2026-10-21T00:00:00Z'::timestamptz
      FROM generate_series(1,1000) n
    `, [OWNER]);
    await pg.query('INSERT INTO kernel.event_subscription_log(subject_did,event_type,payload,occurred_at) VALUES($1,$2,$3,$4)', [
      OWNER, 'warp.agent.dispatched', JSON.stringify({ runId: 'unsettled' }), '2026-10-20T00:00:00Z',
    ]);
    getRun.mockResolvedValue({ ...run(), runId: 'unsettled' });
    await sweepWarpIncurredUsage(new Date('2026-10-23T12:00:00Z'));
    expect(getRun.mock.calls).toEqual([[OWNER, 'unsettled']]);
    expect(list.mock.calls).toEqual([[OWNER, { ancestorRunId: 'unsettled', limit: 500 }]]);
  });
  it.each([
    { label: 'priced and older than 24h', credits: 6500, ageOffset: -1, refetch: false },
    { label: 'zero-priced and older than 24h', credits: 0, ageOffset: -1, refetch: false },
    { label: 'priced at the 24h boundary', credits: 6500, ageOffset: 0, refetch: true },
    { label: 'priced inside the settle window', credits: 6500, ageOffset: 1, refetch: true },
    { label: 'unpriced despite an old terminal', credits: null, ageOffset: -1, refetch: true },
  ])('bounds root API recovery: $label', async ({ credits, ageOffset, refetch }) => {
    const now = new Date('2026-10-23T12:00:00Z');
    const terminalAt = new Date(now.getTime() - WARP_USAGE_SETTLE_MS + ageOffset);
    const observed = {
      ...run(),
      requestUsage: credits === null ? null : { inferenceCost: credits, computeCost: 0, platformCost: 0 },
    };
    await recordWarpRunUsage(OWNER, observed);
    const before = await snapshot();
    await pg.query('INSERT INTO kernel.event_subscription_log(subject_did,event_type,payload,occurred_at) VALUES($1,$2,$3,$4),($1,$5,$6,$7)', [
      OWNER, 'warp.agent.dispatched', JSON.stringify({ runId: 'run-a' }), '2026-10-20T00:00:00Z',
      'warp.run.completed', JSON.stringify(observed), terminalAt.toISOString(),
    ]);
    await sweepWarpIncurredUsage(now);
    expect(getRun.mock.calls).toEqual(refetch ? [[OWNER, 'run-a']] : []);
    expect(list.mock.calls).toEqual(refetch ? [[OWNER, { ancestorRunId: 'run-a', limit: 500 }]] : []);
    if (!refetch) expect(await snapshot()).toEqual(before);
    if (credits === null) expect(await snapshot()).toMatchObject([{ cost_usd: '100.00000000' }]);
  });

  it.each(['warp.run.resumed', 'warp.agent.dispatched', 'warp.run.completed'])(
    'reopens a priced, formerly settled root after newer %s activity', async (eventType) => {
      const now = new Date('2026-10-23T12:00:00Z');
      await recordWarpRunUsage(OWNER, run());
      await pg.query('INSERT INTO kernel.event_subscription_log(subject_did,event_type,payload,occurred_at) VALUES($1,$2,$3,$4),($1,$5,$3,$6),($1,$7,$3,$8)', [
        OWNER, 'warp.agent.dispatched', JSON.stringify(run()), '2026-10-20T00:00:00Z',
        'warp.run.completed', '2026-10-21T00:00:00Z', eventType, '2026-10-23T00:00:00Z',
      ]);
      await sweepWarpIncurredUsage(now);
      expect(getRun.mock.calls).toEqual([[OWNER, 'run-a']]);
      expect(list.mock.calls).toEqual([[OWNER, { ancestorRunId: 'run-a', limit: 500 }]]);
    },
  );

  it('still re-fetches a root with no terminal record or a legacy payload that could not be metered', async () => {
    await pg.query('INSERT INTO kernel.event_subscription_log(subject_did,event_type,payload,occurred_at) VALUES($1,$2,$3,$4),($1,$2,$5,$4),($1,$6,$5,$7)', [
      OWNER, 'warp.agent.dispatched', JSON.stringify({ runId: 'run-a' }), '2026-10-20T00:00:00Z',
      JSON.stringify({ runId: 'legacy' }), 'warp.run.completed', '2026-10-21T00:00:00Z',
    ]);
    getRun.mockResolvedValueOnce({ ...run(), runId: 'run-a' }).mockResolvedValueOnce({ ...run(), runId: 'legacy' });
    await sweepWarpIncurredUsage(new Date('2026-10-23T12:00:00Z'));
    expect(getRun.mock.calls).toEqual([[OWNER, 'run-a'], [OWNER, 'legacy']]);
  });

  it('does not settle a root using a different principal’s terminal observation', async () => {
    await recordWarpRunUsage(OWNER, run());
    await pg.query('INSERT INTO kernel.event_subscription_log(subject_did,event_type,payload,occurred_at) VALUES($1,$2,$3,$4),($5,$6,$3,$7)', [
      OWNER, 'warp.agent.dispatched', JSON.stringify(run()), '2026-10-20T00:00:00Z',
      'did:other', 'warp.run.completed', '2026-10-21T00:00:00Z',
    ]);
    await sweepWarpIncurredUsage(new Date('2026-10-23T12:00:00Z'));
    expect(getRun.mock.calls).toEqual([[OWNER, 'run-a']]);
  });
  it('retries a failed meter write from a durable terminal record without any in-flight dispatch', async () => {
    getClient.mockImplementationOnce(() => { throw new Error('synthetic-private-marker'); });
    expect(await recordWarpRunUsage(OWNER, run())).toBe(false);
    await pg.query('INSERT INTO kernel.event_subscription_log(subject_did,event_type,payload) VALUES($1,$2,$3)',
      [OWNER, 'warp.run.completed', JSON.stringify(run())]);
    await sweepWarpIncurredUsage();
    expect(await snapshot()).toMatchObject([{ external_id: 'run-a', cost_usd: '100.00000000' }]);
    expect(getRun).not.toHaveBeenCalled();
    await sweepWarpIncurredUsage();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('meters paginated terminal descendants after their locally dispatched root is already terminal', async () => {
    for (const event of ['warp.agent.dispatched', 'warp.run.completed']) {
      await pg.query('INSERT INTO kernel.event_subscription_log(subject_did,event_type,payload) VALUES($1,$2,$3)',
        [OWNER, event, JSON.stringify(run())]);
    }
    list.mockResolvedValueOnce({
      runs: [makeAgentRun({ ...run(), runId: 'child', parentRunId: 'run-a', environmentId: null })],
      hasNextPage: true, nextCursor: 'more',
    }).mockResolvedValueOnce({
      runs: [makeAgentRun({ ...run(), runId: 'grandchild', parentRunId: 'child', environmentId: null, state: 'FAILED' })],
      hasNextPage: false, nextCursor: null,
    });
    await sweepWarpIncurredUsage();
    expect((await snapshot()).map(row => row.external_id)).toEqual(['child', 'grandchild', 'run-a']);
    expect(list).toHaveBeenNthCalledWith(2, OWNER, { ancestorRunId: 'run-a', limit: 500, cursor: 'more' });
    expect(publish).toHaveBeenCalledTimes(3);
  });
  it('writes a single canonical run row with credits, actual model, original timestamp and rate provenance', async () => {
    expect(await recordWarpRunUsage(OWNER, run())).toBe(true);
    expect(await snapshot()).toMatchObject([{
      principal_did: OWNER, source: 'adapter:warp', external_id: 'run-a', session_id: 'run-a',
      provider: 'warp', model: 'actual-model', resource: 'external:warp/run',
      quantity: '6500.000000', unit: 'warp-credits', cost_usd: '100.00000000', created_at: new Date(CREATED),
      pricing: { creditRate: { usd: 100, credits: 6500 }, requestUsage: run().requestUsage },
    }]);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ quantity: 6500, costUsd: 100, warpRunId: 'run-a', unit: 'warp-credits' }));
  });

  it('unchanged and stale passes are complete row/event no-ops even after rate change', async () => {
    await recordWarpRunUsage(OWNER, run());
    const before = await snapshot();
    await setRate(200);
    expect(await recordWarpRunUsage(OWNER, run())).toBe(false);
    expect(await recordWarpRunUsage(OWNER, run(6000))).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('resumed growth preserves original rate/timestamp and publishes only its incremental quantity/cost', async () => {
    await recordWarpRunUsage(OWNER, run());
    await setRate(200);
    expect(await recordWarpRunUsage(OWNER, run(13000))).toBe(true);
    expect(await snapshot()).toMatchObject([{
      quantity: '13000.000000', cost_usd: '200.00000000', created_at: new Date(CREATED),
      pricing: { creditRate: { usd: 100, credits: 6500 }, previousCredits: 6500, previousCostUsd: 100 },
    }]);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ quantity: 6500, costUsd: 100 }));
  });

  it('uses configured rate only for newly metered runs and includes same-time terminal children', async () => {
    await setRate(50);
    await recordWarpRunUsage(OWNER, run());
    await recordWarpRunUsage(OWNER, makeAgentRun({ ...run(), runId: 'child', parentRunId: 'run-a', environmentId: null, state: 'FAILED' }));
    expect(await snapshot()).toHaveLength(2);
    expect((await snapshot()).every(row => row.cost_usd === '50.00000000')).toBe(true);
  });

  it('keeps legacy external-adapter rows without our pricing unchanged rather than duplicate or reprice', async () => {
    await pg.exec(`INSERT INTO usage.incurred(id,principal_did,source,external_id,resource,provider,model,cost_usd)
      VALUES('legacy','${OWNER}','adapter:warp','run-a','external:warp/run','warp','legacy-model',12)`);
    const before = await snapshot();
    expect(await recordWarpRunUsage(OWNER, run())).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
  });

  it('atomically deduplicates overlapping insert/growth and refuses a different principal rewriting the run', async () => {
    expect((await Promise.all([recordWarpRunUsage(OWNER, run()), recordWarpRunUsage(OWNER, run())])).filter(Boolean)).toHaveLength(1);
    expect((await Promise.all([recordWarpRunUsage(OWNER, run(13000)), recordWarpRunUsage(OWNER, run(13000))])).filter(Boolean)).toHaveLength(1);
    const before = await snapshot();
    expect(await recordWarpRunUsage('did:other', run(26000))).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(publish.mock.calls.reduce((sum, [event]) => sum + event.costUsd, 0)).toBe(200);
  });

  it('publishes exactly the resulting cumulative total when different snapshots race an initial insert', async () => {
    await Promise.all([recordWarpRunUsage(OWNER, run()), recordWarpRunUsage(OWNER, run(13000))]);
    expect(await snapshot()).toMatchObject([{ cost_usd: '200.00000000', pricing: { credits: 13000 } }]);
    expect(publish.mock.calls.reduce((sum, [event]) => sum + event.quantity, 0)).toBe(13000);
    expect(publish.mock.calls.reduce((sum, [event]) => sum + event.costUsd, 0)).toBe(200);
  });

  it.each(['invalid', [], { usd: 0, credits: 6500 }, { usd: 100, credits: 0 }])('rejects invalid credit-rate config safely (%j)', async (value) => {
    await pg.query('INSERT INTO registry.node_config(key,value) VALUES($1,$2)', [WARP_CREDIT_RATE_CONFIG, JSON.stringify(value)]);
    expect(await recordWarpRunUsage(OWNER, run())).toBe(false);
    expect(await snapshot()).toEqual([]);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('skips nonterminal/pre-cutoff usage but records explicit zero', async () => {
    for (const observation of [
      { ...run(), state: 'INPROGRESS' },
      { ...run(), createdAt: '2026-10-18T23:59:59.999Z' },
      { ...run(), createdAt: null },
    ]) expect(await recordWarpRunUsage(OWNER, observation)).toBe(false);
    expect(warpRunCredits({ ...run(), requestUsage: { inferenceCost: -1, computeCost: 0, platformCost: 0 } })).toBeNull();
    expect(warpRunCredits({ ...run(), state: null })).toBeNull();
    expect(warpRunCredits({ ...run(), requestUsage: { inferenceCost: Number.POSITIVE_INFINITY, computeCost: 0, platformCost: 0 } })).toBeNull();
    expect(warpRunCredits({ ...run(), requestUsage: { inferenceCost: 1e19, computeCost: 0, platformCost: 0 } })).toBeNull();
    expect(await snapshot()).toEqual([]);
    expect(await recordWarpRunUsage(OWNER, { ...run(), requestUsage: { inferenceCost: 0, computeCost: 0, platformCost: 0 } })).toBe(true);
  });

  it('keeps unknown terminal usage visible and upgrades it at the original rate without losing known data', async () => {
    const unknown = { ...run(), requestUsage: null };
    expect(await recordWarpRunUsage(OWNER, unknown)).toBe(true);
    expect(await snapshot()).toMatchObject([{
      quantity: null, cost_usd: null, pricing: { credits: null, creditRate: { usd: 100, credits: 6500 } },
    }]);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ quantity: undefined, costUsd: undefined }));
    const unpriced = await snapshot();
    expect(await recordWarpRunUsage(OWNER, unknown)).toBe(false);
    expect(await snapshot()).toEqual(unpriced);
    await setRate(200);
    expect(await recordWarpRunUsage(OWNER, run())).toBe(true);
    expect(await snapshot()).toMatchObject([{
      quantity: '6500.000000', cost_usd: '100.00000000', created_at: new Date(CREATED),
      pricing: { previousCredits: null, previousCostUsd: null, creditRate: { usd: 100, credits: 6500 } },
    }]);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ quantity: 6500, costUsd: 100 }));
    const priced = await snapshot();
    expect(await recordWarpRunUsage(OWNER, unknown)).toBe(false);
    expect(await snapshot()).toEqual(priced);
  });

  it('stores all-null and malformed terminal usage as unpriced with sanitized numeric/null components', async () => {
    await recordWarpRunUsage(OWNER, { ...run(), requestUsage: { inferenceCost: null, computeCost: null, platformCost: null } });
    await recordWarpRunUsage(OWNER, {
      ...run(), runId: 'malformed',
      requestUsage: { inferenceCost: 'synthetic-private-marker' as unknown as number, computeCost: 100, platformCost: null },
    });
    expect(await snapshot()).toHaveLength(2);
    expect((await snapshot()).every(row => row.cost_usd === null)).toBe(true);
    expect(JSON.stringify(await snapshot())).not.toContain('synthetic-private-marker');
  });

  it('fails open with generic logs and permits retry after a failed meter write', async () => {
    getClient.mockImplementationOnce(() => { throw new Error('synthetic-private-marker'); });
    expect(await recordWarpRunUsage(OWNER, run())).toBe(false);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('synthetic-private-marker');
    expect(await recordWarpRunUsage(OWNER, run())).toBe(true);
    publish.mockRejectedValueOnce(new Error('synthetic-private-marker'));
    expect(await recordWarpRunUsage(OWNER, run(13000))).toBe(true);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('synthetic-private-marker');
  });


  it('retains exact fractional credits and prices tiny resumed growth beyond six quantity decimals', async () => {
    await setRate(6500); // USD 1 per credit.
    const precise = (credits: number) => ({ ...run(), requestUsage: { inferenceCost: credits, computeCost: 0, platformCost: 0 } });
    await recordWarpRunUsage(OWNER, precise(1.12345671));
    expect(await recordWarpRunUsage(OWNER, precise(1.12345679))).toBe(true);
    expect(await snapshot()).toMatchObject([{
      quantity: '1.123457', cost_usd: '1.12345679',
      pricing: { credits: 1.12345679, previousCredits: 1.12345671 },
    }]);
    expect(publish.mock.calls[1][0].quantity).toBeCloseTo(0.00000008, 12);
    expect(publish.mock.calls[1][0].costUsd).toBeCloseTo(0.00000008, 12);
  });
  it('reapplies additive migration without row loss and keeps old writers valid', async () => {
    await recordWarpRunUsage(OWNER, run());
    const before = await snapshot();
    await pg.exec(readFileSync(resolve(ROOT, '0214_usage_incurred_pricing.sql'), 'utf8'));
    expect(await snapshot()).toEqual(before);
    await pg.exec("INSERT INTO usage.incurred(id,principal_did,resource,provider,model) VALUES('old','owner','model:old/x','old','x')");
    expect((await snapshot()).find(row => row.id === 'old')?.pricing).toBeNull();
    await pg.exec("UPDATE usage.emitters SET issuer_did='did:existing-owner' WHERE source='adapter:warp'");
    await pg.exec(readFileSync(resolve(ROOT, '0214_usage_incurred_pricing.sql'), 'utf8'));
    expect((await pg.query("SELECT issuer_did FROM usage.emitters WHERE source='adapter:warp'")).rows)
      .toEqual([{ issuer_did: 'did:existing-owner' }]);
  });
});
