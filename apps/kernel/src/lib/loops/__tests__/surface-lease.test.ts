import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopIngestRequest, LoopRailType } from '../types';
import type { LoopEventPayload } from '@imajin/bus';
import { loopProjectionReactor } from '../../../../../../packages/bus/src/reactors/loop-projection';

const { database } = vi.hoisted(() => ({ database: { sql: null as unknown } }));
vi.mock('@imajin/db', () => ({ getClient: () => database.sql }));
import { projectSurfaceLease as projectLeaseObservation, loopObservationId, SURFACE_LEASE_TTL_MS } from '../surface-lease';
import { getLoopWithHistory } from '../query';
import { CODE_STEP, STEP_ISSUE_UPDATE, STEP_READY } from './horizon-fixtures';

/** Exercise the merged completion transaction, not a pre-publish history write. */
async function projectSurfaceLease(
  observation: LoopIngestRequest,
  prepared: LoopEventPayload = observation.payload,
  canKeepProof = true,
) {
  const conflict = await projectLeaseObservation(observation, prepared, canKeepProof);
  if (observation.type === 'loop.finished') {
    await loopProjectionReactor({
      id: loopObservationId(observation), type: observation.type, payload: prepared,
      issuer: observation.publisherDid, subject: observation.payload.principal, scope: 'loop',
    }, {});
  }
  return conflict;
}

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
let client: PGlite;
const queries: string[] = [];
const now = Date.now();
const stamp = (offset = 0) => new Date(now + offset).toISOString();
function request(type: LoopRailType = 'surface.acquired', overrides: Partial<LoopIngestRequest> = {}): LoopIngestRequest {
  return {
    type,
    payload: { loopId: 'loop-a', kind: 'review', principal: 'did:imajin:alice', state: 'running', summary: 'Working', at: stamp(), surface: 'issue:#2405' },
    publisherDid: 'did:imajin:publisher',
    signature: { keyId: 'a'.repeat(64), alg: 'ed25519', sig: 'b'.repeat(128) },
    ...overrides,
  };
}
function transition(type: LoopRailType, offset: number, payload: Record<string, unknown> = {}) {
  const original = request(type);
  return { ...original, payload: { ...original.payload, at: stamp(offset), ...payload } };
}
async function lease() {
  const result = await client.query<Record<string, unknown>>('SELECT * FROM kernel.surface_lease');
  return result.rows[0];
}

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE SCHEMA kernel;
    CREATE TABLE kernel.bus_chain_configs (
      event_type text, scope text, reactors jsonb, enabled boolean, updated_at timestamptz DEFAULT now(),
      UNIQUE NULLS NOT DISTINCT (event_type, scope)
    );
    CREATE TABLE kernel.loop_events (
      id text PRIMARY KEY, loop_id text, type text, issuer text, principal text, payload jsonb, occurred_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await client.exec(readFileSync(resolve(process.cwd(), 'migrations/archive/pre-kernel-baseline/0157_loops_rail.sql'), 'utf8'));
  const migration = readFileSync(resolve(process.cwd(), 'migrations/archive/pre-kernel-baseline/0194_surface_lease.sql'), 'utf8');
  await client.exec(migration);
  await client.exec(migration);
  const makeTagged = (connection: Pick<PGlite, 'query'>) => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((result, part, i) => result + (i ? `$${i}` : '') + part, '');
    queries.push(text);
    // PGlite is single-connection; advisory locks are only relevant to real
    // multi-connection PostgreSQL. Execute every state-changing SQL verbatim.
    if (text.includes('pg_advisory_xact_lock')) return [];
    return (await connection.query(text, values)).rows;
  };
  const tagged = makeTagged(client);
  database.sql = Object.assign(tagged, {
    begin: (fn: (sql: typeof tagged) => Promise<unknown>) => client.transaction((tx) => fn(makeTagged(tx))),
  });

});
beforeEach(async () => {
  queries.length = 0;
  await client.exec('TRUNCATE kernel.surface_lease, kernel.loop_events, kernel.loops');
});
afterAll(async () => { await client?.close(); });
afterEach(() => { vi.restoreAllMocks(); });

const stepSurface = 'step:next';
const holderDid = 'did:imajin:holder';
const nextDid = 'did:imajin:next';
function stepLease(type: LoopRailType = 'surface.acquired', offset = 0, issuer = holderDid) {
  return { ...transition(type, offset, { surface: stepSurface }), publisherDid: issuer };
}
async function seedStep(loopId = 'loop-a', principal = 'did:imajin:alice') {
  const payload = { ...request().payload, loopId, principal, at: stamp(-SURFACE_LEASE_TTL_MS - 2000) };
  await loopProjectionReactor({ type: 'loop.started', payload, issuer: holderDid, subject: principal, scope: 'loop' }, {});
  for (const [type, fields] of [
    ['step.queued', { step: CODE_STEP }],
    ['step.updated', { update: { ...STEP_ISSUE_UPDATE, ...STEP_READY } }],
  ] as const) {
    await loopProjectionReactor({
      id: `${loopId}-${type}`, type, issuer: holderDid, subject: principal, scope: 'loop',
      payload: { ...payload, state: 'queued', stepId: 'next', ...fields },
    }, {});
  }
}
async function headStep(principal = 'did:imajin:alice', loopId = 'loop-a') {
  return (await getLoopWithHistory(loopId, principal))?.horizon.steps[0];
}

describe('horizon step surface leases', () => {
  beforeEach(async () => { await seedStep(); });

  it('two DIDs claim the same head in the same loop: warning names the first holder and survives retry', async () => {
    expect(await projectSurfaceLease(stepLease())).toBeNull();
    const collision = stepLease('surface.acquired', 1000, nextDid);
    const conflict = { loopId: 'loop-a', holderDid };
    expect(await projectSurfaceLease(collision)).toEqual(conflict);
    expect(await projectSurfaceLease(collision)).toEqual(conflict);
    expect(await headStep()).toMatchObject({
      zone: 'head', state: 'claimed',
      claim: { leaseId: stepSurface, holderDid, acquiredAt: stamp(), expiresAt: stamp(SURFACE_LEASE_TTL_MS) },
    });
    expect((await lease()).issuer).toBe(holderDid);
  });

  it('silent holder expires back to near at the TTL boundary with no cleanup, then the next DID claims', async () => {
    const offset = -SURFACE_LEASE_TTL_MS - 1000;
    await projectSurfaceLease(stepLease('surface.acquired', offset));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 1001);
    expect((await headStep())?.zone).toBe('head');
    clock.mockReturnValue(now - 1000);
    expect(await headStep()).toMatchObject({ zone: 'near', state: 'queued' });
    expect(await headStep()).not.toHaveProperty('claim');
    clock.mockRestore();
    expect(await projectSurfaceLease(stepLease('surface.acquired', 0, nextDid))).toBeNull();
    expect((await headStep())?.claim?.holderDid).toBe(nextDid);
  });

  it('re-acquire extends expiry, but loop progress does not implicitly renew a step', async () => {
    await projectSurfaceLease(stepLease());
    await projectSurfaceLease(stepLease('surface.acquired', 1000));
    const renewed = stamp(1000 + SURFACE_LEASE_TTL_MS);
    expect((await headStep())?.claim?.expiresAt).toBe(renewed);
    await projectSurfaceLease(stepLease('loop.progress', 2000));
    expect((await headStep())?.claim?.expiresAt).toBe(renewed);
  });

  it('release frees the head, retries cannot revive it, and the next DID can claim', async () => {
    const acquisition = stepLease();
    await projectSurfaceLease(acquisition);
    await projectSurfaceLease(stepLease('surface.released', 1000));
    await projectSurfaceLease(acquisition);
    expect(await headStep()).toMatchObject({ zone: 'near', state: 'queued' });
    expect(await headStep()).not.toHaveProperty('claim');
    await projectSurfaceLease(stepLease('surface.acquired', 2000, nextDid));
    expect((await headStep())?.claim?.holderDid).toBe(nextDid);
  });

  it('another DID cannot release or renew the holder; loop completion releases only its issuer', async () => {
    await projectSurfaceLease(stepLease());
    await projectSurfaceLease(stepLease('surface.released', 1000, nextDid));
    expect(await projectSurfaceLease(stepLease('surface.acquired', 2000, nextDid))).toEqual({ loopId: 'loop-a', holderDid });
    await projectSurfaceLease(stepLease('loop.finished', 3000, nextDid));
    expect((await headStep())?.claim?.holderDid).toBe(holderDid);
    await projectSurfaceLease(stepLease('loop.finished', 4000));
    expect((await headStep())?.zone).toBe('near');
  });

  it('enforces owning-loop/declaration prerequisites before writing a step lease', async () => {
    const original = stepLease();
    for (const fields of [{ principal: 'did:imajin:other' }, { loopId: 'missing' }, { surface: 'step:unknown' }, { at: stamp(-SURFACE_LEASE_TTL_MS - 3000) }]) {
      await expect(projectSurfaceLease({ ...original, payload: { ...original.payload, ...fields } }))
        .rejects.toMatchObject({ code: 'loop_owner_conflict' });
    }
    expect(await lease()).toBeUndefined();
  });

  it('does not expose another principal or loop holding in horizon or conflict metadata', async () => {
    await projectSurfaceLease(stepLease());
    expect(await getLoopWithHistory('loop-a', 'did:imajin:bob')).toBeNull();
    await seedStep('loop-b', 'did:imajin:bob');
    const other = stepLease('surface.acquired', 1000, nextDid);
    other.payload = { ...other.payload, loopId: 'loop-b', principal: 'did:imajin:bob' };
    expect(await projectSurfaceLease(other)).toEqual({ loopId: 'loop-a' });
    expect(await projectSurfaceLease(other)).toEqual({ loopId: 'loop-a' });
    expect(await headStep('did:imajin:bob', 'loop-b')).not.toHaveProperty('claim');
    await seedStep('loop-c');
    expect(await headStep('did:imajin:alice', 'loop-c')).not.toHaveProperty('claim');
  });
});

describe('signed surface lease projection', () => {
  it('never restores redacted content through lease or history proof fields', async () => {
    const original = request();
    original.payload.summary = 'Bearer original-secret';
    const prepared = { ...original.payload, summary: 'Bearer [REDACTED]' };
    await projectSurfaceLease(original, prepared, false);
    expect((await lease()).signed_payload).toEqual(prepared);
    const events = await client.query<{ payload: Record<string, unknown> }>('SELECT payload FROM kernel.loop_events');
    expect(events.rows[0].payload.evidence).toMatchObject({ redacted: true });
    expect(events.rows[0].payload.evidence).not.toHaveProperty('signedPayload');
    expect(JSON.stringify(events.rows)).not.toContain('original-secret');
    expect(JSON.stringify(await lease())).not.toContain('original-secret');
  });

  it('retains prepared completion history exactly for the transactional output projection', async () => {
    const original = transition('loop.finished', 1000);
    const prepared = { ...original.payload, output: { kind: 'text' as const, text: '[REDACTED]' } };
    await projectSurfaceLease(original, prepared, false);
    const events = await client.query<{ payload: unknown }>('SELECT payload FROM kernel.loop_events');
    expect(events.rows[0].payload).toEqual(prepared);
  });

  it('rolls back completion state and lease release when output history persistence fails', async () => {
    const original = request();
    await projectSurfaceLease(original);
    await loopProjectionReactor({
      type: 'loop.started', payload: original.payload,
      issuer: original.publisherDid, subject: original.payload.principal, scope: 'loop',
    }, {});
    const beforeLease = await lease();
    const beforeLoop = (await client.query('SELECT * FROM kernel.loops')).rows;
    await client.exec(`
      CREATE FUNCTION kernel.reject_completion_history() RETURNS trigger AS $$
      BEGIN
        IF NEW.type = 'loop.finished' THEN RAISE EXCEPTION 'history unavailable'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_completion_history BEFORE INSERT ON kernel.loop_events
        FOR EACH ROW EXECUTE FUNCTION kernel.reject_completion_history();
    `);
    try {
      await expect(projectSurfaceLease(transition('loop.finished', 1000))).rejects.toThrow('history unavailable');
      expect(await lease()).toEqual(beforeLease);
      expect((await client.query('SELECT * FROM kernel.loops')).rows).toEqual(beforeLoop);
      expect((await client.query("SELECT * FROM kernel.loop_events WHERE type = 'loop.finished'")).rows).toHaveLength(0);
    } finally {
      await client.exec('DROP TRIGGER reject_completion_history ON kernel.loop_events; DROP FUNCTION kernel.reject_completion_history();');
    }
  });

  it('does not release a lease when the same-principal completion has another issuer', async () => {
    await projectSurfaceLease(request());
    const before = await lease();
    await projectSurfaceLease({ ...transition('loop.finished', 1000), publisherDid: 'did:imajin:other' });
    expect(await lease()).toEqual(before);
  });
  it.each(['surface.acquired', 'surface.released', 'surface.conflicted'] as const)('never trusts publisher-supplied projection metadata on %s or retry', async (type) => {
    const forgedMetadata = transition(type, 0, { observedConflictingLoopId: 'injected-loop' });
    expect(await projectSurfaceLease(forgedMetadata)).toBeNull();
    expect(await projectSurfaceLease(forgedMetadata)).toBeNull();
  });
  it('acquires a single holder with fifteen-minute TTL and exact issuer evidence', async () => {
    expect(await projectSurfaceLease(request())).toBeNull();
    const row = await lease();
    expect(row).toMatchObject({ surface: 'issue:#2405', loop_id: 'loop-a', principal: 'did:imajin:alice', issuer: request().publisherDid, signature: request().signature, signed_payload: request().payload, released_at: null });
    expect(new Date(row.expires_at as string).getTime() - new Date(row.acquired_at as string).getTime()).toBe(SURFACE_LEASE_TTL_MS);
    expect(queries.some((text) => text.includes('pg_advisory_xact_lock'))).toBe(true);
    const history = await client.query<{ payload: unknown }>('SELECT payload FROM kernel.loop_events');
    expect(history.rows[0].payload).toMatchObject({ evidence: { signedPayload: request().payload, signature: request().signature } });
  });

  it('returns a conflicting loop without replacing or blocking the live holder', async () => {
    await projectSurfaceLease(request());
    const result = await projectSurfaceLease(transition('surface.acquired', 1000, { loopId: 'loop-b' }));
    expect(result).toEqual({ loopId: 'loop-a', holderDid: request().publisherDid });
    expect((await lease()).loop_id).toBe('loop-a');
  });

  it('detects collisions across principals without moving the holder', async () => {
    await projectSurfaceLease(request());
    expect(await projectSurfaceLease(transition('surface.acquired', 1000, { loopId: 'loop-b', principal: 'did:imajin:bob' }))).toEqual({ loopId: 'loop-a' });
    expect((await lease()).principal).toBe('did:imajin:alice');
  });

  it('returns the same collision outcome on retry so failed conflict emission is recoverable', async () => {
    await projectSurfaceLease(request());
    const collision = transition('surface.acquired', 1000, { loopId: 'loop-b' });
    expect(await projectSurfaceLease(collision)).toEqual({ loopId: 'loop-a', holderDid: request().publisherDid });
    expect(await projectSurfaceLease(collision)).toEqual({ loopId: 'loop-a', holderDid: request().publisherDid });
    expect((await client.query('SELECT * FROM kernel.loop_events')).rows).toHaveLength(2);
  });

  it('does not resurrect an acquisition delivered after its release', async () => {
    await projectSurfaceLease(transition('surface.released', 1000));
    await projectSurfaceLease(request());
    expect(await lease()).toBeUndefined();
  });

  it('honors a later signed loop completion delivered before acquisition', async () => {
    await projectSurfaceLease(transition('loop.finished', 1000));
    await projectSurfaceLease(request());
    expect(await lease()).toBeUndefined();
  });

  it('renews a same-holder acquisition without generating a conflict', async () => {
    await projectSurfaceLease(request());
    expect(await projectSurfaceLease(transition('surface.acquired', 1000))).toBeNull();
    expect(new Date((await lease()).heartbeat_at as string).toISOString()).toBe(stamp(1000));
  });

  it('release marks releasedAt and a different loop can subsequently acquire', async () => {
    await projectSurfaceLease(request());
    await projectSurfaceLease(transition('surface.released', 1000));
    expect(new Date((await lease()).released_at as string).toISOString()).toBe(stamp(1000));
    expect(await projectSurfaceLease(transition('surface.acquired', 2000, { loopId: 'loop-b' }))).toBeNull();
    expect(await lease()).toMatchObject({ loop_id: 'loop-b', released_at: null });
  });

  it('treats TTL-expired holdings as free without polling or a sweep', async () => {
    await projectSurfaceLease(transition('surface.acquired', -SURFACE_LEASE_TTL_MS - 1000));
    expect(await projectSurfaceLease(transition('surface.acquired', 0, { loopId: 'loop-b' }))).toBeNull();
    expect((await lease()).loop_id).toBe('loop-b');
  });

  it('heartbeats only live holdings and extends expiry from the signed progress time', async () => {
    await projectSurfaceLease(request());
    await projectSurfaceLease(transition('loop.progress', 2000));
    expect(new Date((await lease()).expires_at as string).getTime()).toBe(now + 2000 + SURFACE_LEASE_TTL_MS);
  });

  it('never resurrects an expired lease through heartbeat', async () => {
    await projectSurfaceLease(transition('surface.acquired', -SURFACE_LEASE_TTL_MS - 1000));
    await projectSurfaceLease(transition('loop.progress', 0));
    expect(new Date((await lease()).expires_at as string).getTime()).toBeLessThan(now);
  });

  it.each(['surface.released', 'loop.progress'] as const)('ignores wrong loop/principal/issuer for %s', async (type) => {
    await projectSurfaceLease(request());
    const before = await lease();
    await projectSurfaceLease(transition(type, 1000, { principal: 'did:imajin:bob' }));
    await projectSurfaceLease(transition(type, 2000, { loopId: 'loop-other' }));
    await projectSurfaceLease({ ...transition(type, 3000), publisherDid: 'did:imajin:other' });
    expect(await lease()).toEqual(before);
  });

  it('does not allow another principal or issuer to steal a live same-loop holding', async () => {
    await projectSurfaceLease(request());
    const before = await lease();
    await projectSurfaceLease(transition('surface.acquired', 1000, { principal: 'did:imajin:bob' }));
    await projectSurfaceLease({ ...transition('surface.acquired', 2000), publisherDid: 'did:imajin:other' });
    expect(await lease()).toEqual(before);
  });

  it('finishing a loop releases its holdings and a progress replay cannot revive them', async () => {
    await projectSurfaceLease(request());
    await projectSurfaceLease(transition('loop.finished', 2000));
    await projectSurfaceLease(transition('loop.progress', 3000));
    expect(new Date((await lease()).released_at as string).toISOString()).toBe(stamp(2000));
  });

  it('retries do not duplicate history, renew, or resurrect a released acquisition', async () => {
    await projectSurfaceLease(request());
    await projectSurfaceLease(transition('surface.released', 1000));
    await projectSurfaceLease(request());
    expect((await lease()).released_at).not.toBeNull();
    const rows = await client.query('SELECT * FROM kernel.loop_events');
    expect(rows.rows).toHaveLength(2);
  });

  it('older unique acquisitions, releases, and heartbeats cannot regress the holder watermark', async () => {
    await projectSurfaceLease(request());
    await projectSurfaceLease(transition('loop.progress', 3000));
    const before = await lease();
    await projectSurfaceLease(transition('surface.acquired', 1000));
    await projectSurfaceLease(transition('surface.released', 2000));
    await projectSurfaceLease(transition('loop.progress', 2000));
    expect(await lease()).toEqual(before);
  });

  it('conflict events are auditable history only, never a lease mutation', async () => {
    await projectSurfaceLease(request());
    const before = await lease();
    await projectSurfaceLease(transition('surface.conflicted', 1000, { loopId: 'loop-b', refs: { conflictingLoopId: 'loop-a' } }));
    expect(await lease()).toEqual(before);
    const rows = await client.query('SELECT * FROM kernel.loop_events');
    expect(rows.rows).toHaveLength(2);
  });

  it.each(['loop.started', 'loop.blocked'] as const)('%s does not touch holdings', async (type) => {
    expect(await projectSurfaceLease(request(type))).toBeNull();
    expect(queries).toHaveLength(0);
  });
});
