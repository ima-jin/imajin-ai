import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { canonicalize } from '@imajin/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusEvent, LoopEventPayload } from '@imajin/bus';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const { getClient } = vi.hoisted(() => ({ getClient: vi.fn() }));
vi.mock('@imajin/db', () => ({ getClient }));

import { loopProjectionReactor } from '../../../../../../packages/bus/src/reactors/loop-projection';
import { getLoopWithHistory } from '../query';
import { getLoopOutputArtifact, putLoopOutputArtifact } from '../artifact-store';
import { prepareLoopOutput, redactLoopEnvelope, reserveLoopOwnership } from '../prepare-output';
import type { LoopEnvelope } from '../types';

type SqlRows = Record<string, unknown>[];
type TaggedSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<SqlRows>;

// No SQL interpretation in this adapter: production query text and parameters
// execute against Postgres. PGlite has one backend, so concurrent calls test
// atomic SQL guards, not multi-backend lock contention.
function taggedSql(executor: Pick<PGlite, 'query'>): TaggedSql {
  return async (strings, ...values) => {
    const text = strings.reduce((sql, part, index) => sql + (index ? `$${index}` : '') + part, '');
    return (await executor.query<Record<string, unknown>>(text, values)).rows;
  };
}

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../migrations');
const outputMigration = readdirSync(migrationsDir).find(name => name.endsWith('_loop_output_artifacts.sql'));
const migrationNames = ['0157_loops_rail.sql', '0194_surface_lease.sql', outputMigration];
const PRINCIPAL = 'did:imajin:owner';
const OTHER = 'did:imajin:other';
const AT = '2026-10-16T12:00:00.000Z';
let pg: PGlite;

function envelope(overrides: Partial<LoopEnvelope> = {}): LoopEnvelope {
  return {
    loopId: 'loop_sql', kind: 'warp.run', principal: PRINCIPAL,
    state: 'running', summary: 'Working', at: AT, ...overrides,
  };
}

function event(payload: LoopEnvelope | LoopEventPayload, type = 'loop.progress'): BusEvent {
  return { type, issuer: 'did:imajin:publisher', subject: payload.principal, scope: 'loop', payload };
}

async function applyMigrations() {
  for (const name of migrationNames) {
    if (!name) throw new Error('Missing loop output artifact migration');
    await pg.exec(readFileSync(join(migrationsDir, name), 'utf8'));
  }
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  // Minimal bus dependency, including the real post-0098 NULL-scope uniqueness.
  await pg.exec(`
    CREATE SCHEMA kernel;
    CREATE TABLE kernel.bus_chain_configs (
      event_type text NOT NULL, scope text, reactors jsonb NOT NULL,
      enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE NULLS NOT DISTINCT (event_type, scope)
    );
  `);
  await applyMigrations();
  await applyMigrations();
  getClient.mockReturnValue(Object.assign(taggedSql(pg), {
    begin: (work: (sql: TaggedSql) => Promise<void>) =>
      pg.transaction(tx => work(taggedSql(tx))),
  }));
});

beforeEach(async () => {
  await pg.exec('TRUNCATE kernel.loop_events, kernel.loops, kernel.loop_output_artifacts');
});

afterAll(async () => {
  await pg?.close();
});

describe('loop output SQL isolation against real embedded Postgres', () => {
  it('applies migrations repeatedly without losing rows or duplicating lifecycle chains', async () => {
    await loopProjectionReactor(event(envelope(), 'loop.started'), {});
    const before = await getLoopWithHistory('loop_sql', PRINCIPAL);
    await applyMigrations();
    expect(await getLoopWithHistory('loop_sql', PRINCIPAL)).toEqual(before);
    const chains = await pg.query<{ event_type: string }>(
      'SELECT event_type FROM kernel.bus_chain_configs ORDER BY event_type',
    );
    expect(chains.rows.map(row => row.event_type))
      .toEqual(['loop.blocked', 'loop.finished', 'loop.progress', 'loop.started', 'surface.acquired', 'surface.conflicted', 'surface.released']);
  });

  it('preserves opaque typed output and older history without regressing the projection', async () => {
    const output = {
      kind: 'tool_result' as const, callId: 'call_1',
      result: { unknown: [{ count: 2, valid: false, empty: null }], text: 'unchanged' },
    };
    await loopProjectionReactor(event(envelope({ output }), 'loop.started'), {});
    await loopProjectionReactor(event(envelope({
      state: 'queued', summary: 'Older', at: '2026-10-16T11:00:00.000Z',
    })), {});
    const history = await getLoopWithHistory('loop_sql', PRINCIPAL);
    expect(history?.loop.state).toBe('running');
    expect(history?.events).toHaveLength(2);
    expect(history?.events[1].payload.output).toEqual(output);
    await loopProjectionReactor(event(envelope({
      state: 'succeeded', at: '2026-10-16T13:00:00.000Z',
    }), 'loop.finished'), {});
    expect((await getLoopWithHistory('loop_sql', PRINCIPAL))?.loop.finishedAt)
      .toBe('2026-10-16T13:00:00.000Z');
  });

  it.each(['loop.started', 'loop.progress', 'loop.blocked', 'loop.finished'])(
    'rejects a foreign principal through %s without changing projection or history',
    async (type) => {
      await loopProjectionReactor(event(envelope()), {});
      const before = await getLoopWithHistory('loop_sql', PRINCIPAL);
      await expect(loopProjectionReactor(event(envelope({
        principal: OTHER, summary: 'Takeover', at: '2026-10-16T13:00:00.000Z',
      }), type), {})).rejects.toMatchObject({ code: 'loop_owner_conflict' });
      expect(await getLoopWithHistory('loop_sql', PRINCIPAL)).toEqual(before);
      expect(await getLoopWithHistory('loop_sql', OTHER)).toBeNull();
      const rows = await pg.query('SELECT principal FROM kernel.loop_events');
      expect(rows.rows).toEqual([{ principal: PRINCIPAL }]);
    },
  );

  it('allows only one of two concurrent initial ownership reservations', async () => {
    const claims = await Promise.all([
      reserveLoopOwnership('loop.started', envelope()),
      reserveLoopOwnership('loop.started', envelope({ principal: OTHER })),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims[0] ? PRINCIPAL : OTHER;
    const loser = winner === PRINCIPAL ? OTHER : PRINCIPAL;
    await loopProjectionReactor(event(envelope({ principal: winner })), {});
    await expect(loopProjectionReactor(event(envelope({ principal: loser })), {}))
      .rejects.toMatchObject({ code: 'loop_owner_conflict' });
    expect((await getLoopWithHistory('loop_sql', winner))?.events).toHaveLength(1);
    expect(await getLoopWithHistory('loop_sql', loser)).toBeNull();
  });

  it('rolls back both first creation and subsequent projection updates if history insert fails', async () => {
    await pg.exec(`
      ALTER TABLE kernel.loop_events ADD CONSTRAINT reject_test_history
      CHECK (payload->>'summary' <> 'reject-history');
    `);
    try {
      await expect(loopProjectionReactor(event(envelope({ summary: 'reject-history' })), {}))
        .rejects.toThrow();
      expect(await getLoopWithHistory('loop_sql', PRINCIPAL)).toBeNull();
      await loopProjectionReactor(event(envelope()), {});
      const before = await getLoopWithHistory('loop_sql', PRINCIPAL);
      await expect(loopProjectionReactor(event(envelope({
        summary: 'reject-history', state: 'failed', at: '2026-10-16T13:00:00.000Z',
      })), {})).rejects.toThrow();
      expect(await getLoopWithHistory('loop_sql', PRINCIPAL)).toEqual(before);
    } finally {
      await pg.exec('ALTER TABLE kernel.loop_events DROP CONSTRAINT reject_test_history');
    }
  });

  it('excludes legacy foreign history and breaks timestamp ties by id in the actual SQL query', async () => {
    await loopProjectionReactor(event(envelope()), {});
    await pg.exec('DELETE FROM kernel.loop_events');
    for (const [id, principal] of [['evt_z', PRINCIPAL], ['evt_foreign', OTHER], ['evt_a', PRINCIPAL]]) {
      await pg.query(`
        INSERT INTO kernel.loop_events (id, loop_id, type, issuer, principal, payload, occurred_at)
        VALUES ($1, 'loop_sql', 'loop.progress', 'did:imajin:publisher', $2, '{}', $3::timestamptz)
      `, [id, principal, AT]);
    }
    expect((await getLoopWithHistory('loop_sql', PRINCIPAL))?.events.map(row => row.id))
      .toEqual(['evt_a', 'evt_z']);
  });

  it('stores complete redacted oversized output idempotently and scopes reads to owner plus loop', async () => {
    const payload = redactLoopEnvelope(envelope({
      output: { kind: 'tool_result', callId: 'call_1', result: {
        apiKey: 'synthetic-private-value', text: '界'.repeat(6000), nested: [false, null, 42],
      } },
    }));
    expect(await reserveLoopOwnership('loop.started', payload)).toBe(true);
    const prepared = await prepareLoopOutput(payload);
    expect(prepared.output).toMatchObject({ kind: 'tool_result', truncated: true });
    if (!prepared.output || !('artifactRef' in prepared.output)) throw new Error('Expected stored output');
    const ref = prepared.output.artifactRef;
    await loopProjectionReactor(event(prepared, 'loop.started'), {});
    expect((await getLoopWithHistory('loop_sql', PRINCIPAL))?.events[0].payload.output).toEqual(prepared.output);
    const artifact = await getLoopOutputArtifact('loop_sql', PRINCIPAL, ref.id);
    expect(artifact?.output).toEqual(payload.output);
    expect(JSON.stringify(artifact)).not.toContain('synthetic-private-value');
    const content = canonicalize(artifact?.output);
    expect(ref.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(ref.byteLength).toBe(Buffer.byteLength(content, 'utf8'));
    expect(await getLoopOutputArtifact('loop_sql', OTHER, ref.id)).toBeNull();
    expect(await getLoopOutputArtifact('another_loop', PRINCIPAL, ref.id)).toBeNull();
    expect(await putLoopOutputArtifact('loop_sql', PRINCIPAL, payload.output!)).toEqual(ref);
    await applyMigrations();
    const rows = await pg.query('SELECT id FROM kernel.loop_output_artifacts');
    expect(rows.rows).toEqual([{ id: ref.id }]);
  });
});
