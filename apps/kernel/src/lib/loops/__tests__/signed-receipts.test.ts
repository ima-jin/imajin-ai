import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { canonicalize, crypto } from '@imajin/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusEvent } from '../../../../../../packages/bus/src/types';
import type { LoopIngestRequest } from '../types';
import { serializeLoopEvent, type RawLoopEventRow } from '../serialize';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(), resolver: vi.fn(), node: vi.fn(), authorize: vi.fn(), auth: vi.fn(),
}));
vi.mock('@imajin/db', () => ({ getClient: () => mocks.sql }));
vi.mock('@/src/db', () => ({ db: {}, identities: {} }));
vi.mock('@imajin/auth/resolve-db', () => ({ createDbResolver: () => mocks.resolver }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: mocks.node }));
vi.mock('../authorize-publisher', () => ({ authorizeLoopPublisher: mocks.authorize }));
vi.mock('@imajin/auth', async original => ({
  ...await original<object>(), requireAuth: mocks.auth,
}));
vi.mock('@imajin/bus', async () => ({
  publish: async (type: string, event: Omit<BusEvent, 'type'>) => {
    const { loopProjectionReactor } = await import('../../../../../../packages/bus/src/reactors/loop-projection');
    await loopProjectionReactor({ ...event, type }, {});
  },
}));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}), corsOptions: () => new Response(null, { status: 204 }),
}));

import { ingestLoopEvent } from '../ingest';
import { loopObservationId } from '../surface-lease';
import { getLoopWithHistory } from '../query';
import { verifyStoredLoopReceipt } from '../verify-stored-receipt';
import { parseLoopIngestRequest } from '../types';
import { POST, GET as LIST } from '../../../../app/api/loops/route';
import { GET } from '../../../../app/api/loops/[loopId]/route';

const pg = new PGlite();
const principal = 'did:imajin:person';
const publisherDid = 'did:imajin:publisher';
const key = crypto.generateKeypair();
const migration = readFileSync(new URL('../../../../../../migrations/0232_loop_event_signed_receipts.sql', import.meta.url), 'utf8');
function tagged(executor: Pick<PGlite, 'query'>) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
    return (await executor.query(query, values)).rows;
  };
}
function signed(extra: Partial<LoopIngestRequest['payload']> = {}, type: LoopIngestRequest['type'] = 'loop.started'): LoopIngestRequest {
  const fields = {
    type, payload: {
      loopId: 'receipt-loop', kind: 'agent.run', principal, state: 'running',
      summary: 'Receipt', at: new Date().toISOString(), ...extra,
    },
  };
  return {
    ...fields, publisherDid,
    signature: { keyId: key.publicKey, alg: 'ed25519', sig: crypto.signSync(canonicalize(fields), key.privateKey) },
  };
}
async function history() {
  const result = await getLoopWithHistory('receipt-loop', principal);
  if (!result) throw new Error('Missing loop');
  return result;
}
async function post(request: unknown) {
  return POST(new Request('https://test.imajin.ai/api/loops', {
    method: 'POST', body: JSON.stringify(request),
  }) as Parameters<typeof POST>[0]);
}
async function read() {
  return GET(new Request('https://test.imajin.ai/api/loops/receipt-loop') as Parameters<typeof GET>[0], {
    params: Promise.resolve({ loopId: 'receipt-loop' }),
  });
}

beforeAll(async () => {
  await pg.exec(`CREATE SCHEMA kernel;
    CREATE TABLE kernel.bus_chain_configs (
      event_type text, scope text, reactors jsonb, enabled boolean, updated_at timestamptz,
      UNIQUE NULLS NOT DISTINCT(event_type, scope)
    );`);
  for (const name of ['0157_loops_rail.sql', '0193_loop_output_artifacts.sql', '0194_surface_lease.sql']) {
    await pg.exec(readFileSync(new URL(`../../../../../../migrations/archive/pre-kernel-baseline/${name}`, import.meta.url), 'utf8'));
  }
  await pg.exec(readFileSync(new URL('../../../../../../migrations/0231_usage_projection_chain.sql', import.meta.url), 'utf8'));
  await pg.exec(migration);
  mocks.sql.mockImplementation(tagged(pg));
  Object.assign(mocks.sql, { begin: (work: (tx: ReturnType<typeof tagged>) => Promise<unknown>) =>
    pg.transaction(tx => work(tagged(tx))) });
}, 30_000);
beforeEach(async () => {
  await pg.exec('TRUNCATE kernel.loop_events, kernel.loops, kernel.surface_lease, kernel.loop_output_artifacts');
  mocks.node.mockReturnValue({ senderDid: 'did:imajin:node', senderPubkey: key.publicKey });
  mocks.resolver.mockImplementation(async (did: string) => did === publisherDid ? { publicKey: key.publicKey } : null);
  mocks.authorize.mockResolvedValue({ authorized: true });
  mocks.auth.mockResolvedValue({ identity: { id: principal } });
});
afterAll(() => pg.close());

describe('signed receipt store', () => {
  it.each(['loop.started', 'loop.progress', 'surface.acquired'] as const)(
    'rejects a real signed legacy-ref %s before receipt, projection, or artifact writes', async type => {
      const refs = { runId: 'run', sessionKey: 'harness-only', futureRef: 'ignored' };
      const request = signed({
        refs, ...(type === 'surface.acquired' ? { surface: 'issue:#3268' } : {}),
      }, type);
      expect((await post(request)).status).toBe(400);
      expect((await pg.query('SELECT id FROM kernel.loop_events')).rows).toEqual([]);
      expect((await pg.query('SELECT loop_id FROM kernel.loops')).rows).toEqual([]);
      expect((await pg.query('SELECT id FROM kernel.loop_output_artifacts')).rows).toEqual([]);
    },
  );
  it.each(['publisherProof', 'evidence', 'observedConflictingLoopId', 'observedConflictingHolderDid'])(
    'rejects oversized surface output with reserved %s before writes', async field => {
      const request = signed({
        surface: 'issue:#3268', [field]: 'caller-metadata',
        output: { kind: 'text', text: 'x'.repeat(20000) },
      }, 'surface.acquired');
      expect(await ingestLoopEvent(request)).toMatchObject({ status: 400 });
      expect((await pg.query('SELECT id FROM kernel.loop_events')).rows).toEqual([]);
      expect((await pg.query('SELECT id FROM kernel.loop_output_artifacts')).rows).toEqual([]);
    },
  );
  it('retains exact inline publisher metadata inside its server proof without trusting it', async () => {
    expect(await ingestLoopEvent(signed())).toEqual({ ok: true });
    const request = signed({
      publisherProof: 'caller-metadata', evidence: { description: 'caller-evidence' },
      observedConflictingLoopId: 'untrusted', surface: 'issue:#3268',
    }, 'surface.acquired');
    expect(await ingestLoopEvent(request)).toEqual({ ok: true });
    const event = (await history()).events.find(row => row.type === 'surface.acquired')!;
    expect(await verifyStoredLoopReceipt(event)).toEqual({ ok: true });
  });
  it('round-trips a real signed POST through SQL and the loop read API', async () => {
    const request = signed();
    expect((await post(request)).status).toBe(201);
    const response = await read();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.events[0]).toMatchObject({
      id: loopObservationId(request), signature: request.signature, publisherDid, causeEventId: null,
    });
    expect(await verifyStoredLoopReceipt(body.events[0])).toEqual({ ok: true });
    const row = await pg.query('SELECT signature, publisher_did, cause_event_id FROM kernel.loop_events');
    expect(row.rows).toEqual([{ signature: request.signature, publisher_did: publisherDid, cause_event_id: null }]);
  });

  it('walks a three-receipt cause chain to the root and re-verifies every receipt', async () => {
    const root = signed();
    const child = signed({ causeEventId: loopObservationId(root), summary: 'Child' }, 'loop.progress');
    const leaf = signed({ causeEventId: loopObservationId(child), summary: 'Leaf' }, 'loop.finished');
    for (const request of [root, child, leaf]) expect(await ingestLoopEvent(request)).toEqual({ ok: true });
    const rows = new Map((await history()).events.map(event => [event.id, event]));
    let id: string | null | undefined = loopObservationId(leaf);
    const visited: string[] = [];
    while (id) {
      const event = rows.get(id)!;
      expect(await verifyStoredLoopReceipt(event)).toEqual({ ok: true });
      visited.push(event.id);
      id = event.causeEventId;
    }
    expect(visited).toEqual([leaf, child, root].map(loopObservationId));
  });

  it('makes re-ingesting an event id a no-op for history and projection timestamps', async () => {
    const request = signed();
    expect(await ingestLoopEvent(request)).toEqual({ ok: true });
    const before = await history();
    expect(await ingestLoopEvent(request)).toEqual({ ok: true });
    expect(await history()).toEqual(before);
    expect(before.events).toHaveLength(1);
  });

  it.each(['missing', 'bad', 'tampered', 'unknown-key', 'unauthorized'] as const)(
    'stores no receipt for %s signed ingest', async failure => {
      const request = signed();
      if (failure === 'missing') delete (request as Partial<LoopIngestRequest>).signature;
      if (failure === 'bad') request.signature.sig = '0'.repeat(128);
      if (failure === 'tampered') request.payload.summary = 'Changed after signing';
      if (failure === 'unknown-key') mocks.resolver.mockResolvedValue(null);
      if (failure === 'unauthorized') mocks.authorize.mockResolvedValue({ authorized: false });
      expect((await post(request)).status).toBe(failure === 'unauthorized' ? 403 : 400);
      expect((await pg.query('SELECT id FROM kernel.loop_events')).rows).toEqual([]);
      expect((await pg.query('SELECT loop_id FROM kernel.loops')).rows).toEqual([]);
    },
  );

  it.each([42, '', ' ', 'x'.repeat(513)])('rejects invalid signed cause %s before writes', async causeEventId => {
    const request = signed({ causeEventId } as unknown as LoopIngestRequest['payload']);
    expect(parseLoopIngestRequest(request).ok).toBe(false);
    expect(await ingestLoopEvent(request)).toMatchObject({ status: 400 });
    expect((await pg.query('SELECT id FROM kernel.loop_events')).rows).toEqual([]);
  });

  it('enforces the cause self-FK and rolls back the projection on a dangling cause', async () => {
    const root = signed();
    expect(await ingestLoopEvent(root)).toEqual({ ok: true });
    const before = await history();
    expect(await ingestLoopEvent(signed({ causeEventId: 'absent', state: 'failed' }, 'loop.finished')))
      .toMatchObject({ status: 500 });
    expect(await history()).toEqual(before);
  });

  it.each(['summary', 'type', 'id', 'signature', 'publisherDid', 'causeEventId', 'principal', 'issuer', 'loopId', 'occurredAt'])(
    'rejects stored %s tampering', async field => {
      await ingestLoopEvent(signed());
      const event = structuredClone((await history()).events[0]);
      if (field === 'summary') event.payload.summary = 'Changed stored projection';
      else if (field === 'signature') event.signature!.sig = '0'.repeat(128);
      else Object.assign(event, { [field]: 'tampered' });
      expect((await verifyStoredLoopReceipt(event)).ok).toBe(false);
    },
  );

  it('reconstructs safe oversized output from its scoped artifact for re-verification', async () => {
    const request = signed({ output: { kind: 'text', text: '界'.repeat(6000) } });
    expect(await ingestLoopEvent(request)).toEqual({ ok: true });
    const event = (await history()).events[0];
    expect(event.payload.output).toMatchObject({ truncated: true });
    expect(event.payload).not.toHaveProperty('publisherProof');
    expect(await verifyStoredLoopReceipt(event)).toEqual({ ok: true });
    await pg.exec(`UPDATE kernel.loop_output_artifacts SET content = '{"kind":"text","text":"altered"}'`);
    expect((await verifyStoredLoopReceipt(event)).ok).toBe(false);
    const missing = structuredClone(event);
    if (!missing.payload.output || !('artifactRef' in missing.payload.output)) throw new Error('Missing output artifact');
    missing.payload.output.artifactRef.id = 'absent';
    expect((await verifyStoredLoopReceipt(missing)).ok).toBe(false);
  });

  it('rejects redaction-changing facts rather than persisting an unverifiable receipt', async () => {
    expect(await ingestLoopEvent(signed({ summary: 'Bearer synthetic-private-value' }))).toMatchObject({ status: 400 });
    expect((await pg.query('SELECT id FROM kernel.loop_events')).rows).toEqual([]);
    expect((await pg.query('SELECT loop_id FROM kernel.loops')).rows).toEqual([]);
  });

  it('persists surface receipt evidence and causal links as well as lifecycle receipts', async () => {
    const root = signed();
    await ingestLoopEvent(root);
    const request = signed({ causeEventId: loopObservationId(root), surface: 'issue:#3268' }, 'surface.acquired');
    expect(await ingestLoopEvent(request)).toEqual({ ok: true });
    const event = (await history()).events.find(row => row.type === 'surface.acquired')!;
    expect(event).toMatchObject({ signature: request.signature, publisherDid, causeEventId: loopObservationId(root) });
    expect(await verifyStoredLoopReceipt(event)).toEqual({ ok: true });
  });

  it.each([false, true])('uses the effective identity for receipt detail and list reads (acting-as-org=%s)', async org => {
    const owner = org ? 'did:imajin:org' : principal;
    await ingestLoopEvent(signed({ principal: owner }));
    mocks.auth.mockResolvedValue({ identity: { id: principal, ...(org ? { actingAs: owner } : {}) } });
    expect((await read()).status).toBe(200);
    const request = new Request('https://test.imajin.ai/api/loops') as Parameters<typeof LIST>[0];
    expect((await (await LIST(request)).json()).loops[0].principal).toBe(owner);
    mocks.auth.mockResolvedValue({ identity: { id: 'did:imajin:other' } });
    expect((await read()).status).toBe(404);
    expect((await (await LIST(request)).json()).loops).toEqual([]);
    mocks.auth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await read()).status).toBe(401);
  });
});

describe('additive SQL migration', () => {
  it.each([false, true])('migrates the baseline loop table with existing rows=%s', async populated => {
    const scratch = new PGlite();
    try {
      const baseline = readFileSync(new URL('../../../../../../migrations/0001_kernel_baseline.sql', import.meta.url), 'utf8');
      const table = baseline.match(/CREATE TABLE kernel\.loop_events \([\s\S]*?\r?\n\);/)?.[0];
      if (!table) throw new Error('Missing baseline loop_events definition');
      const primaryKey = baseline.match(/ALTER TABLE ONLY kernel\.loop_events\r?\n\s+ADD CONSTRAINT loop_events_pkey PRIMARY KEY \(id\);/)?.[0];
      if (!primaryKey) throw new Error('Missing baseline loop_events primary key');
      await scratch.exec(`CREATE SCHEMA kernel; ${table} ${primaryKey}`);
      if (populated) {
        await scratch.exec(`INSERT INTO kernel.loop_events
          (id,loop_id,type,issuer,principal,payload,occurred_at)
          VALUES ('old','legacy-loop','loop.progress','did:imajin:publisher','did:imajin:person',
            '{"loopId":"legacy-loop","summary":"Historical observation"}','2026-09-01T00:00:00Z')`);
      }
      const before = (await scratch.query('SELECT * FROM kernel.loop_events')).rows;
      await scratch.exec(migration);
      await scratch.exec(migration);
      expect((await scratch.query('SELECT * FROM kernel.loop_events')).rows)
        .toEqual(before.map(row => ({ ...row, signature: null, publisher_did: null, cause_event_id: null })));
    } finally {
      await scratch.close();
    }
  }, 30_000);
  it('is idempotent on fresh tables and preserves a populated legacy snapshot without fabricated evidence', async () => {
    const snapshot = signed();
    await pg.query(`INSERT INTO kernel.loop_events (id, loop_id, type, issuer, principal, payload, occurred_at)
      VALUES ('legacy', $1, $2, $3, $4, $5, $6)`,
    [snapshot.payload.loopId, snapshot.type, publisherDid, principal, JSON.stringify(snapshot.payload), snapshot.payload.at]);
    const before = (await pg.query('SELECT * FROM kernel.loop_events')).rows;
    await pg.exec(migration);
    await pg.exec(migration);
    expect((await pg.query('SELECT * FROM kernel.loop_events')).rows).toEqual(before);
    const row = before[0];
    expect(row).toMatchObject({ signature: null, publisher_did: null, cause_event_id: null });
    expect((await verifyStoredLoopReceipt(serializeLoopEvent(row as unknown as RawLoopEventRow))).ok).toBe(false);
    const columns = await pg.query(`SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'kernel' AND table_name = 'loop_events'
        AND column_name IN ('signature','publisher_did','cause_event_id') ORDER BY column_name`);
    expect(columns.rows).toEqual(['cause_event_id', 'publisher_did', 'signature'].map(column_name => ({ column_name, is_nullable: 'YES' })));
    const indexes = await pg.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'kernel'
      AND indexname = 'idx_loop_events_cause_event_id'`);
    expect(indexes.rows[0].indexdef).toContain('(cause_event_id)');
  });
});
