/**
 * Unit tests for the scoped delegation grant lifecycle (#1882).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const { grantsStore, capsStore, GRANTS_TABLE, CAPS_TABLE } = vi.hoisted(() => {
  const grantsStore = new Map<string, Row>();
  const capsStore = new Map<string, Row>();

  // Column tokens are identity-mapped to their own field name — safe because
  // grants.ts never mixes columns from both tables inside a single `and()`
  // (see the two-query introspectGrant design), so there is no cross-table
  // name collision to worry about in this mock.
  const GRANTS_TABLE = {
    __table: 'grants',
    id: 'id', agentDid: 'agentDid', delegatorDid: 'delegatorDid', audience: 'audience',
    onBehalfOf: 'onBehalfOf', issuedAt: 'issuedAt', expiresAt: 'expiresAt', status: 'status',
    revokedAt: 'revokedAt', createdAt: 'createdAt', updatedAt: 'updatedAt',
  };
  const CAPS_TABLE = {
    __table: 'caps',
    id: 'id', grantId: 'grantId', capability: 'capability', status: 'status',
    revokedAt: 'revokedAt', createdAt: 'createdAt',
  };

  return { grantsStore, capsStore, GRANTS_TABLE, CAPS_TABLE };
});

function storeFor(table: { __table: string }): Map<string, Row> {
  return table.__table === 'grants' ? grantsStore : capsStore;
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
  return { ...actual, eq, gt, inArray, and };
});

/**
 * Wraps an already-computed row set (evaluated exactly once, before this is
 * called) so `.limit()`/`.returning()` chain off the same result an `await`
 * would see — mirroring a real query, which does not re-run itself per
 * chained accessor. This matters for `update(...).where(...).returning(...)`:
 * evaluating the predicate lazily and more than once would re-filter against
 * rows this same call already mutated.
 */
function queryable(rows: Row[]) {
  const p = Promise.resolve(rows);
  return {
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    returning: (projection?: Record<string, string>) => Promise.resolve(project(rows, projection)),
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
} from '../grants';

const DELEGATOR = 'did:imajin:ryan';
const AGENT = 'did:imajin:matchmaker-agent';
const OTHER_AGENT = 'did:imajin:other-agent';
const TARGET = 'did:imajin:contact-x';

beforeEach(() => {
  grantsStore.clear();
  capsStore.clear();
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
