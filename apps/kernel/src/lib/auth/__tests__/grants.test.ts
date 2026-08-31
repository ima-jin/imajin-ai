/**
 * Unit tests for the scoped delegation grant lifecycle (#1882).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const { grantsStore, capsStore, eventsStore, GRANTS_TABLE, CAPS_TABLE, EVENTS_TABLE } = vi.hoisted(() => {
  const grantsStore = new Map<string, Row>();
  const capsStore = new Map<string, Row>();
  const eventsStore = new Map<string, Row>();

  // Column tokens are identity-mapped to their own field name — safe because
  // grants.ts never mixes columns from both tables inside a single `and()`
  // (see the two-query introspectGrant design), so there is no cross-table
  // name collision to worry about in this mock.
  const GRANTS_TABLE = {
    __table: 'grants',
    id: 'id', agentDid: 'agentDid', delegatorDid: 'delegatorDid', audience: 'audience',
    onBehalfOf: 'onBehalfOf', issuedAt: 'issuedAt', expiresAt: 'expiresAt', status: 'status',
    revokedAt: 'revokedAt', lastUsedAt: 'lastUsedAt', createdAt: 'createdAt', updatedAt: 'updatedAt',
  };
  const CAPS_TABLE = {
    __table: 'caps',
    id: 'id', grantId: 'grantId', capability: 'capability', status: 'status',
    revokedAt: 'revokedAt', createdAt: 'createdAt',
  };
  const EVENTS_TABLE = {
    __table: 'events',
    id: 'id', grantId: 'grantId', event: 'event', capability: 'capability',
    actorDid: 'actorDid', createdAt: 'createdAt',
  };

  return { grantsStore, capsStore, eventsStore, GRANTS_TABLE, CAPS_TABLE, EVENTS_TABLE };
});

function storeFor(table: { __table: string }): Map<string, Row> {
  if (table.__table === 'grants') return grantsStore;
  if (table.__table === 'caps') return capsStore;
  return eventsStore;
}

/** Project `rows` through a `{ resultKey: sourceField }` map, or pass through unprojected. */
function project(rows: Row[], projection?: Record<string, string>): Row[] {
  if (!projection) return rows;
  return rows.map((row) => projectRow(row, projection));
}

function projectRow(row: Row, projection: Record<string, string>): Row {
  const result: Row = {};
  for (const key of Object.keys(projection)) result[key] = row[projection[key]];
  return result;
}

interface DescSpec { __desc: string }

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const eq = (column: string, value: unknown): Predicate => (row) => row[column] === value;
  const gt = (column: string, value: unknown): Predicate => {
    const b = value instanceof Date ? value.getTime() : (value as number);
    return (row) => {
      const raw = row[column] as Date | number | undefined;
      if (raw === undefined) return false;
      const a = raw instanceof Date ? raw.getTime() : raw;
      return a > b;
    };
  };
  const inArray = (column: string, values: readonly unknown[]): Predicate => (row) => values.includes(row[column]);
  const and = (...preds: Predicate[]): Predicate => (row) => preds.every((p) => p(row));
  const desc = (column: string): DescSpec => ({ __desc: column });
  return { ...actual, eq, gt, inArray, and, desc };
});

/**
 * Wraps an already-computed row set (evaluated exactly once, before this is
 * called) so `.limit()`/`.returning()` chain off the same result an `await`
 * would see — mirroring a real query, which does not re-run itself per
 * chained accessor. This matters for `update(...).where(...).returning(...)`:
 * evaluating the predicate lazily and more than once would re-filter against
 * rows this same call already mutated.
 */
function sortByDesc(rows: Row[], spec?: DescSpec): Row[] {
  if (!spec) return rows;
  const { __desc: column } = spec;
  return [...rows].sort((a, b) => {
    const av = a[column] instanceof Date ? (a[column] as Date).getTime() : (a[column] as number);
    const bv = b[column] instanceof Date ? (b[column] as Date).getTime() : (b[column] as number);
    return bv - av;
  });
}

function queryable(rows: Row[]) {
  const p = Promise.resolve(rows);
  return {
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    returning: (projection?: Record<string, string>) => Promise.resolve(project(rows, projection)),
    orderBy: (spec?: DescSpec) => Promise.resolve(sortByDesc(rows, spec)),
  };
}

function insertInto(table: { __table: string }) {
  return {
    values: (data: Row | Row[]) => {
      const store = storeFor(table);
      const rows = Array.isArray(data) ? data : [data];
      for (const row of rows) store.set(String(row.id), { ...row });
      return Promise.resolve([]);
    },
  };
}

function deleteFrom(table: { __table: string }) {
  return {
    where: (predicate: Predicate) => {
      const store = storeFor(table);
      for (const [id, row] of store) if (predicate(row)) store.delete(id);
      return Promise.resolve([]);
    },
  };
}

function applyUpdate(store: Map<string, Row>, patch: Row, predicate: Predicate): Row[] {
  const touched: Row[] = [];
  for (const [id, row] of store) {
    if (!predicate(row)) continue;
    const next = { ...row, ...patch };
    store.set(id, next);
    touched.push(next);
  }
  return touched;
}

function updateTable(table: { __table: string }) {
  return {
    set: (patch: Row) => ({
      where: (predicate: Predicate) => queryable(applyUpdate(storeFor(table), patch, predicate)),
    }),
  };
}

function selectFrom(projection?: Record<string, string>) {
  return {
    from: (table: { __table: string }) => ({
      where: (predicate: Predicate) => queryable(project([...storeFor(table).values()].filter(predicate), projection)),
    }),
  };
}

vi.mock('@/src/db', () => ({
  db: {
    insert: insertInto,
    delete: deleteFrom,
    update: updateTable,
    select: selectFrom,
  },
  delegationGrants: GRANTS_TABLE,
  delegationGrantCapabilities: CAPS_TABLE,
  delegationGrantEvents: EVENTS_TABLE,
}));

vi.mock('@/src/lib/kernel/id', () => {
  let counter = 0;
  return { generateId: (prefix: string) => `${prefix}_${++counter}` };
});

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import {
  issueGrant,
  revokeGrant,
  revokeGrantCapability,
  renewGrant,
  introspectGrant,
  listGrantsForDelegator,
  listGrantDetailsForDelegator,
  grantStatusLabel,
} from '../grants';

const DELEGATOR = 'did:imajin:ryan';
const AGENT = 'did:imajin:matchmaker-agent';
const OTHER_AGENT = 'did:imajin:other-agent';
const TARGET = 'did:imajin:contact-x';

beforeEach(() => {
  grantsStore.clear();
  capsStore.clear();
  eventsStore.clear();
  vi.clearAllMocks();
});

describe('issueGrant — grammar and shape validation', () => {
  it('rejects unknown capabilities', async () => {
    const result = await issueGrant({
      delegatorDid: DELEGATOR,
      agentDid: AGENT,
      capabilities: ['messages:write', 'bogus:scope'],
      audience: { type: 'all' },
    });
    expect(result).toMatchObject({ status: 400, error: expect.stringContaining('bogus:scope') });
    expect(grantsStore.size).toBe(0);
  });

  it('rejects an empty capabilities array', async () => {
    const result = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: [], audience: { type: 'all' } });
    expect(result).toMatchObject({ status: 400 });
  });

  it('rejects a malformed audience (no DID patterns/wildcards, no bare object)', async () => {
    const result = await issueGrant({
      delegatorDid: DELEGATOR,
      agentDid: AGENT,
      capabilities: ['messages:write'],
      audience: { type: 'dids', values: ['did:imajin:*'] },
    });
    expect(result).toMatchObject({ status: 400 });
  });

  it('rejects agentDid === delegatorDid', async () => {
    const result = await issueGrant({
      delegatorDid: DELEGATOR,
      agentDid: DELEGATOR,
      capabilities: ['messages:write'],
      audience: { type: 'all' },
    });
    expect(result).toMatchObject({ status: 400 });
  });

  it('issues a grant with deduped, validated capabilities and returns dual-stamp identifiers', async () => {
    const result = await issueGrant({
      delegatorDid: DELEGATOR,
      agentDid: AGENT,
      capabilities: ['messages:write', 'intros:propose', 'messages:write'],
      audience: { type: 'all' },
    });
    expect('grant' in result).toBe(true);
    if (!('grant' in result)) throw new Error('expected grant');
    expect(result.grant.delegatorDid).toBe(DELEGATOR);
    expect(result.grant.agentDid).toBe(AGENT);
    expect(result.grant.capabilities.sort()).toEqual(['intros:propose', 'messages:write']);
    expect(result.grant.grantId).toMatch(/^grant_/);
    expect(grantsStore.size).toBe(1);
    expect(capsStore.size).toBe(2);
  });

  it('clamps ttlMs to the configured maximum lease bound', async () => {
    const result = await issueGrant({
      delegatorDid: DELEGATOR,
      agentDid: AGENT,
      capabilities: ['messages:write'],
      audience: { type: 'all' },
      ttlMs: Number.MAX_SAFE_INTEGER,
    });
    if (!('grant' in result)) throw new Error('expected grant');
    const issuedAt = new Date(result.grant.issuedAt).getTime();
    const expiry = new Date(result.grant.expiry).getTime();
    // 30 days is the configured GRANT_MAX_TTL.
    expect(expiry - issuedAt).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000 + 1000);
  });
});

describe('per-capability revocation (#1882 item 4)', () => {
  it('revokes exactly one capability, leaving its siblings and the grant itself active', async () => {
    const issued = await issueGrant({
      delegatorDid: DELEGATOR,
      agentDid: AGENT,
      capabilities: ['messages:write', 'intros:propose'],
      audience: { type: 'all' },
    });
    if (!('grant' in issued)) throw new Error('expected grant');
    const { grantId } = issued.grant;

    const revoked = await revokeGrantCapability({ grantId, capability: 'messages:write', requestedBy: DELEGATOR });
    expect(revoked).toEqual({ revoked: true });

    await expect(introspectGrant({ agentDid: AGENT, capability: 'messages:write' })).resolves.toMatchObject({ authorized: false });
    await expect(introspectGrant({ agentDid: AGENT, capability: 'intros:propose' })).resolves.toMatchObject({ authorized: true, grantId });
  });

  it('rejects revocation from anyone other than the issuing delegator', async () => {
    const issued = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    if (!('grant' in issued)) throw new Error('expected grant');

    const result = await revokeGrantCapability({ grantId: issued.grant.grantId, capability: 'messages:write', requestedBy: 'did:imajin:someone-else' });
    expect(result).toMatchObject({ status: 403 });
  });

  it('reports revoked: false for an already-revoked capability', async () => {
    const issued = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    if (!('grant' in issued)) throw new Error('expected grant');
    await revokeGrantCapability({ grantId: issued.grant.grantId, capability: 'messages:write', requestedBy: DELEGATOR });

    const second = await revokeGrantCapability({ grantId: issued.grant.grantId, capability: 'messages:write', requestedBy: DELEGATOR });
    expect(second).toEqual({ revoked: false });
  });

  it('returns 404 for a non-existent grant', async () => {
    const result = await revokeGrantCapability({ grantId: 'grant_nope', capability: 'messages:write', requestedBy: DELEGATOR });
    expect(result).toMatchObject({ status: 404 });
  });
});

describe('whole-grant revocation', () => {
  it('revokes the grant and fails introspection for every capability on it', async () => {
    const issued = await issueGrant({
      delegatorDid: DELEGATOR,
      agentDid: AGENT,
      capabilities: ['messages:write', 'intros:propose'],
      audience: { type: 'all' },
    });
    if (!('grant' in issued)) throw new Error('expected grant');

    await expect(revokeGrant({ grantId: issued.grant.grantId, requestedBy: DELEGATOR })).resolves.toEqual({ revoked: true });

    await expect(introspectGrant({ agentDid: AGENT, capability: 'messages:write' })).resolves.toMatchObject({ authorized: false });
    await expect(introspectGrant({ agentDid: AGENT, capability: 'intros:propose' })).resolves.toMatchObject({ authorized: false });
  });

  it('rejects revocation from anyone other than the issuing delegator', async () => {
    const issued = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    if (!('grant' in issued)) throw new Error('expected grant');

    const result = await revokeGrant({ grantId: issued.grant.grantId, requestedBy: 'did:imajin:someone-else' });
    expect(result).toMatchObject({ status: 403 });
  });
});

describe('renewGrant — leases, not perpetual authority', () => {
  it('extends the expiry of an active grant', async () => {
    // Issue with a short lease, then renew with the (much longer) default —
    // the renewed expiry must be unambiguously later than the original.
    const issued = await issueGrant({
      delegatorDid: DELEGATOR,
      agentDid: AGENT,
      capabilities: ['messages:write'],
      audience: { type: 'all' },
      ttlMs: 1000,
    });
    if (!('grant' in issued)) throw new Error('expected grant');
    const originalExpiry = new Date(issued.grant.expiry).getTime();

    const renewed = await renewGrant({ grantId: issued.grant.grantId, requestedBy: DELEGATOR });
    if (!('grantId' in renewed)) throw new Error('expected renewal');
    expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(originalExpiry);
  });

  it('rejects renewal from anyone other than the issuing delegator', async () => {
    const issued = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    if (!('grant' in issued)) throw new Error('expected grant');

    const result = await renewGrant({ grantId: issued.grant.grantId, requestedBy: 'did:imajin:someone-else' });
    expect(result).toMatchObject({ status: 403 });
  });

  it('refuses to renew a revoked grant — it must be re-issued instead', async () => {
    const issued = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    if (!('grant' in issued)) throw new Error('expected grant');
    await revokeGrant({ grantId: issued.grant.grantId, requestedBy: DELEGATOR });

    const result = await renewGrant({ grantId: issued.grant.grantId, requestedBy: DELEGATOR });
    expect(result).toMatchObject({ status: 409 });
  });
});

describe('introspectGrant — fail-closed resolution', () => {
  it('denies an agent with no grant at all', async () => {
    await expect(introspectGrant({ agentDid: OTHER_AGENT, capability: 'messages:write' })).resolves.toMatchObject({ authorized: false });
  });

  it('denies a capability the agent was never granted', async () => {
    await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['intros:propose'], audience: { type: 'all' } });
    await expect(introspectGrant({ agentDid: AGENT, capability: 'messages:write' })).resolves.toMatchObject({ authorized: false });
  });

  it('denies an unknown/unregistered capability string outright', async () => {
    await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    await expect(introspectGrant({ agentDid: AGENT, capability: 'bogus:scope' })).resolves.toMatchObject({ authorized: false });
  });

  it('denies an expired grant even though it was never explicitly revoked', async () => {
    const issued = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    if (!('grant' in issued)) throw new Error('expected grant');
    // Simulate lease expiry without any revocation action.
    grantsStore.set(issued.grant.grantId, { ...grantsStore.get(issued.grant.grantId), expiresAt: new Date(Date.now() - 1000) });

    await expect(introspectGrant({ agentDid: AGENT, capability: 'messages:write' })).resolves.toMatchObject({ authorized: false });
  });

  it('denies a revoked grant on the very next check (no eventual-revocation window)', async () => {
    const issued = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    if (!('grant' in issued)) throw new Error('expected grant');
    await expect(introspectGrant({ agentDid: AGENT, capability: 'messages:write' })).resolves.toMatchObject({ authorized: true });

    await revokeGrant({ grantId: issued.grant.grantId, requestedBy: DELEGATOR });
    await expect(introspectGrant({ agentDid: AGENT, capability: 'messages:write' })).resolves.toMatchObject({ authorized: false });
  });
});

describe('introspectGrant — delegatorDid narrowing (#1895, #1897)', () => {
  it('authorizes when the narrowed delegatorDid matches the live grant\'s own delegator', async () => {
    const issued = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['intros:propose'], audience: { type: 'all' } });
    if (!('grant' in issued)) throw new Error('expected grant');

    await expect(
      introspectGrant({ agentDid: AGENT, capability: 'intros:propose', delegatorDid: DELEGATOR }),
    ).resolves.toMatchObject({ authorized: true, grantId: issued.grant.grantId });
  });

  it('denies when the agent holds a live grant, but not from the claimed delegator (absent grant from that delegator)', async () => {
    const otherDelegator = 'did:imajin:someone-else';
    await issueGrant({ delegatorDid: otherDelegator, agentDid: AGENT, capabilities: ['intros:propose'], audience: { type: 'all' } });

    await expect(
      introspectGrant({ agentDid: AGENT, capability: 'intros:propose', delegatorDid: DELEGATOR }),
    ).resolves.toMatchObject({ authorized: false });
  });

  it('denies a delegator-narrowed lookup once the delegator\'s own grant is revoked', async () => {
    const issued = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['intros:propose'], audience: { type: 'all' } });
    if (!('grant' in issued)) throw new Error('expected grant');
    await revokeGrant({ grantId: issued.grant.grantId, requestedBy: DELEGATOR });

    await expect(
      introspectGrant({ agentDid: AGENT, capability: 'intros:propose', delegatorDid: DELEGATOR }),
    ).resolves.toMatchObject({ authorized: false });
  });

  it('allows an "all" audience against any target', async () => {
    await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    await expect(introspectGrant({ agentDid: AGENT, capability: 'messages:write', targetDid: TARGET })).resolves.toMatchObject({ authorized: true });
  });

  it('denies a "dids" audience when the target is not enumerated', async () => {
    await issueGrant({
      delegatorDid: DELEGATOR,
      agentDid: AGENT,
      capabilities: ['messages:write'],
      audience: { type: 'dids', values: [TARGET] },
    });
    await expect(introspectGrant({ agentDid: AGENT, capability: 'messages:write', targetDid: 'did:imajin:someone-else' }))
      .resolves.toMatchObject({ authorized: false });
  });

  it('denies a "dids" audience when no target is supplied at all', async () => {
    await issueGrant({
      delegatorDid: DELEGATOR,
      agentDid: AGENT,
      capabilities: ['messages:write'],
      audience: { type: 'dids', values: [TARGET] },
    });
    await expect(introspectGrant({ agentDid: AGENT, capability: 'messages:write' })).resolves.toMatchObject({ authorized: false });
  });

  it('allows a "dids" audience when the target is enumerated, and returns dual-stamp provenance', async () => {
    const issued = await issueGrant({
      delegatorDid: DELEGATOR,
      agentDid: AGENT,
      capabilities: ['messages:write'],
      audience: { type: 'dids', values: [TARGET] },
    });
    if (!('grant' in issued)) throw new Error('expected grant');

    await expect(introspectGrant({ agentDid: AGENT, capability: 'messages:write', targetDid: TARGET })).resolves.toMatchObject({
      authorized: true,
      grantId: issued.grant.grantId,
      delegatorDid: DELEGATOR,
      agentDid: AGENT,
    });
  });

  it('propagates a storage error rather than resolving to an allow', async () => {
    const { db } = await import('@/src/db');
    vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('connection terminated');
    });

    await expect(introspectGrant({ agentDid: AGENT, capability: 'messages:write' })).rejects.toThrow('connection terminated');
  });
});

describe('listGrantsForDelegator', () => {
  it('scopes results to the requesting delegator and includes only active capabilities', async () => {
    const mine = await issueGrant({
      delegatorDid: DELEGATOR,
      agentDid: AGENT,
      capabilities: ['messages:write', 'intros:propose'],
      audience: { type: 'all' },
    });
    if (!('grant' in mine)) throw new Error('expected grant');
    await issueGrant({ delegatorDid: 'did:imajin:someone-else', agentDid: OTHER_AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    await revokeGrantCapability({ grantId: mine.grant.grantId, capability: 'messages:write', requestedBy: DELEGATOR });

    const grants = await listGrantsForDelegator(DELEGATOR);
    expect(grants).toHaveLength(1);
    expect(grants[0].grantId).toBe(mine.grant.grantId);
    expect(grants[0].capabilities).toEqual(['intros:propose']);
  });

  it('returns an empty list for a delegator with no grants', async () => {
    await expect(listGrantsForDelegator('did:imajin:nobody')).resolves.toEqual([]);
  });
});

describe('grantStatusLabel — #1887 grants-view read surface', () => {
  const NOW = new Date('2026-08-30T00:00:00.000Z');

  it('labels a revoked grant as revoked regardless of expiry', () => {
    expect(grantStatusLabel({ status: 'revoked', expiresAt: '2027-01-01T00:00:00.000Z', now: NOW })).toBe('revoked');
  });

  it('labels an unexpired, unrevoked grant as active', () => {
    expect(grantStatusLabel({ status: 'active', expiresAt: '2027-01-01T00:00:00.000Z', now: NOW })).toBe('active');
  });

  it('labels a grant expiring within 24 hours as expiring', () => {
    expect(grantStatusLabel({ status: 'active', expiresAt: '2026-08-30T12:00:00.000Z', now: NOW })).toBe('expiring');
  });

  it('labels a lapsed grant as expired', () => {
    expect(grantStatusLabel({ status: 'active', expiresAt: '2026-08-29T00:00:00.000Z', now: NOW })).toBe('expired');
  });
});

describe('grant lifecycle audit trail (#1887)', () => {
  it('records an "issued" event when a grant is created', async () => {
    const issued = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    if (!('grant' in issued)) throw new Error('expected grant');

    const details = await listGrantDetailsForDelegator(DELEGATOR);
    expect(details[0].history).toEqual([
      expect.objectContaining({ event: 'issued', actorDid: DELEGATOR, capability: null }),
    ]);
  });

  it('records both an "issued" and a "renewed" event on the grant\u2019s history', async () => {
    const issued = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    if (!('grant' in issued)) throw new Error('expected grant');
    await renewGrant({ grantId: issued.grant.grantId, requestedBy: DELEGATOR });

    const details = await listGrantDetailsForDelegator(DELEGATOR);
    expect(details[0].history.map((h) => h.event).sort()).toEqual(['issued', 'renewed']);
  });

  it('records a "capability_revoked" event naming the capability', async () => {
    const issued = await issueGrant({
      delegatorDid: DELEGATOR,
      agentDid: AGENT,
      capabilities: ['messages:write', 'intros:propose'],
      audience: { type: 'all' },
    });
    if (!('grant' in issued)) throw new Error('expected grant');
    await revokeGrantCapability({ grantId: issued.grant.grantId, capability: 'messages:write', requestedBy: DELEGATOR });

    const details = await listGrantDetailsForDelegator(DELEGATOR);
    expect(details[0].history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'capability_revoked', capability: 'messages:write', actorDid: DELEGATOR }),
      ]),
    );
  });

  it('records a "revoked" event for whole-grant revocation, but not when the grant was already revoked', async () => {
    const issued = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    if (!('grant' in issued)) throw new Error('expected grant');

    await revokeGrant({ grantId: issued.grant.grantId, requestedBy: DELEGATOR });
    await revokeGrant({ grantId: issued.grant.grantId, requestedBy: DELEGATOR }); // no-op second call

    const details = await listGrantDetailsForDelegator(DELEGATOR);
    expect(details[0].history.filter((h) => h.event === 'revoked')).toHaveLength(1);
  });

  it('bumps lastUsedAt on a successful introspection and leaves it null until then', async () => {
    const issued = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    if (!('grant' in issued)) throw new Error('expected grant');

    expect((await listGrantDetailsForDelegator(DELEGATOR))[0].lastUsedAt).toBeNull();

    await introspectGrant({ agentDid: AGENT, capability: 'messages:write' });

    expect((await listGrantDetailsForDelegator(DELEGATOR))[0].lastUsedAt).not.toBeNull();
  });

  it('does not bump lastUsedAt on a denied introspection', async () => {
    const issued = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    if (!('grant' in issued)) throw new Error('expected grant');

    await introspectGrant({ agentDid: AGENT, capability: 'intros:propose' }); // never granted

    expect((await listGrantDetailsForDelegator(DELEGATOR))[0].lastUsedAt).toBeNull();
  });
});

describe('listGrantDetailsForDelegator — #1887 grants-view read surface', () => {
  it('includes every capability regardless of status, unlike listGrantsForDelegator', async () => {
    const issued = await issueGrant({
      delegatorDid: DELEGATOR,
      agentDid: AGENT,
      capabilities: ['messages:write', 'intros:propose'],
      audience: { type: 'all' },
    });
    if (!('grant' in issued)) throw new Error('expected grant');
    await revokeGrantCapability({ grantId: issued.grant.grantId, capability: 'messages:write', requestedBy: DELEGATOR });

    const details = await listGrantDetailsForDelegator(DELEGATOR);
    expect(details[0].capabilities.sort((a, b) => a.capability.localeCompare(b.capability))).toEqual([
      { capability: 'intros:propose', status: 'active', revokedAt: null },
      { capability: 'messages:write', status: 'revoked', revokedAt: expect.any(String) },
    ]);
  });

  it('keeps a fully revoked grant in the list — the record does not disappear because the authority did', async () => {
    const issued = await issueGrant({ delegatorDid: DELEGATOR, agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } });
    if (!('grant' in issued)) throw new Error('expected grant');
    await revokeGrant({ grantId: issued.grant.grantId, requestedBy: DELEGATOR });

    const details = await listGrantDetailsForDelegator(DELEGATOR);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ grantId: issued.grant.grantId, status: 'revoked' });
  });

  it('returns an empty list for a delegator with no grants', async () => {
    await expect(listGrantDetailsForDelegator('did:imajin:nobody')).resolves.toEqual([]);
  });
});
