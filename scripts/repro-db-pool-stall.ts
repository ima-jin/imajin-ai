import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { getClient } from '../packages/db/src/client';
import { checkDatabaseLiveness } from '../packages/db/src/liveness';
import { boundSql } from '../packages/db/src/bounds';
import { deferAfterCommit } from '../packages/db/src/transaction-effects';
import postgres from 'postgres';

/** Local-only harness; never invokes PM2 or changes application rows. */
async function main() {
  const { createProbe, checkHealth, POLICY } = await import('../deploy/liveness-probe.mjs');
  const configured = process.env.DB_BOUNDS_REPRO_URL;
  assert(configured, 'Set DB_BOUNDS_REPRO_URL to a disposable loopback database');
  const url = new URL(configured);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Repro requires loopback');
  assert.equal(url.pathname, '/imajin_runtime_repro', 'Repro requires a dedicated database');
  url.searchParams.set('statement_timeout', '0');
  url.searchParams.set('idle_in_transaction_session_timeout', '0');
  process.env.DATABASE_URL = url.toString();
  // Short overrides exercise the same max-10 production pool without a long wait.
  process.env.DB_ACQUIRE_TIMEOUT_MS = '200';
  process.env.DB_QUERY_TIMEOUT_MS = '2000';
  process.env.DB_STATEMENT_TIMEOUT_MS = '300';
  process.env.DB_IDLE_TRANSACTION_TIMEOUT_MS = '500';
  const client = getClient();
  let held: Awaited<ReturnType<typeof client.reserve>>[] = [];
  const release = () => { for (const sql of held) sql.release(); held = []; };
  const server = createServer(async (_request, response) => {
    const database = await checkDatabaseLiveness();
    response.writeHead(database ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ database }));
  });
  try {
    await client`SELECT 1`;
    const [settings] = await client`
      SELECT current_setting('statement_timeout') AS statement,
        current_setting('idle_in_transaction_session_timeout') AS idle
    `;
    assert.equal(settings.statement, '300ms');
    assert.equal(settings.idle, '500ms');
    const statementStart = Date.now();
    await assert.rejects(client`SELECT pg_sleep(1)`, { code: '57014' });
    const statementMs = Date.now() - statementStart;
    let effectRan = false;
    await client.begin(async tx => {
      await tx`SELECT 1`;
      await tx.savepoint(async () => {
        deferAfterCommit(async () => { effectRan = true; });
      });
      assert.equal(effectRan, false, 'Savepoint must not deliver before outer commit');
    });
    assert.equal(effectRan, true);
    const idleStart = Date.now();
    await assert.rejects(client.begin(async tx => {
      await tx`SELECT 1`;
      await delay(800);
    }));
    const idleMs = Date.now() - idleStart;
    assert(idleMs < 1500, 'Idle transaction did not expire');
    const raw = postgres(configured, { max: 1 });
    const slow = boundSql(raw, { acquireMs: 200, queryMs: 100 });
    let queryMs: number;
    try {
      await raw`SELECT 1`;
      const queryStart = Date.now();
      await assert.rejects(slow.unsafe('SELECT pg_sleep(1)').values(), { code: 'DB_QUERY_TIMEOUT' });
      queryMs = Date.now() - queryStart;
      assert(queryMs < 1000, 'Client query deadline did not fire');
      await raw`SELECT 1`;
    } finally { await raw.end({ timeout: 1 }); }
    held = await Promise.all(Array.from({ length: 10 }, () => client.reserve()));
    const start = Date.now();
    await assert.rejects(client`SELECT 1`, { code: 'DB_ACQUIRE_TIMEOUT' });
    const checkoutMs = Date.now() - start;
    assert(checkoutMs < 1500, 'Pool checkout exceeded its bound');
    let lateCallback = false;
    await assert.rejects(client.begin(async () => { lateCallback = true; }), { code: 'DB_ACQUIRE_TIMEOUT' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const target = { app: 'prod-jin', port };
    assert.equal(await checkHealth(target), false);
    const restarts: string[] = [];
    const delivered: unknown[] = [];
    const probe = createProbe({}, {
      pid: async () => 12345,
      restart: async (app: string) => { restarts.push(app); release(); },
      deliver: async (event: unknown) => { delivered.push(event); return true; },
    }, { ...POLICY, startupGraceMs: 0 });
    for (let i = 0; i < 3; i++) await probe.tick([target], { execute: true, kernelPort: port });
    assert.deepEqual(restarts, ['prod-jin']);
    assert.equal(delivered.length, 1);
    assert.equal(await checkHealth(target), true);
    await delay(50);
    assert.equal(lateCallback, false, 'Timed-out transaction executed late');
    held = await Promise.all(Array.from({ length: 10 }, () => client.reserve()));
    for (let i = 0; i < 3; i++) await probe.tick([target], { execute: true, kernelPort: port });
    assert.deepEqual(restarts, ['prod-jin'], 'Cooldown must prevent a restart storm');
    release();
    assert.equal(await checkHealth(target), true);
    console.info(JSON.stringify({
      result: 'PASS', poolMax: 10, statementMs, idleMs, queryMs, checkoutMs,
      restarts, delivered: delivered.length, recovered: true, cooldown: true, lateCallback,
    }));
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await client.end({ timeout: 1 });
  }
}

main().catch(() => {
  // Never stringify connection errors: they can contain credentials/URL fields.
  console.error('Pool-stall repro failed; check disposable DB readiness and the harness assertions');
  process.exitCode = 1;
});
