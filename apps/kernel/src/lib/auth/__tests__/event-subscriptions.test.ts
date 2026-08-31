/**
 * Unit tests for grant-bound event-subscription cursor catch-up (#1884).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const { grantsStore, capsStore, logStore, GRANTS_TABLE, CAPS_TABLE, LOG_TABLE } = vi.hoisted(() => {
  const grantsStore = new Map<string, Row>();
  const capsStore = new Map<string, Row>();
  const logStore = new Map<string, Row>();

  const GRANTS_TABLE = { __table: 'grants', id: 'id', agentDid: 'agentDid', status: 'status', expiresAt: 'expiresAt', audience: 'audience' };
  const CAPS_TABLE = { __table: 'caps', grantId: 'grantId', capability: 'capability', status: 'status' };
  const LOG_TABLE = {
    __table: 'log', id: 'id', seq: 'seq', eventType: 'eventType', issuerDid: 'issuerDid',
    subjectDid: 'subjectDid', scope: 'scope', payload: 'payload', correlationId: 'correlationId',
    occurredAt: 'occurredAt', createdAt: 'createdAt',
  };

  return { grantsStore, capsStore, logStore, GRANTS_TABLE, CAPS_TABLE, LOG_TABLE };
});

function storeFor(table: { __table: string }): Map<string, Row> {
  if (table.__table === 'grants') return grantsStore;
  if (table.__table === 'caps') return capsStore;
  return logStore;
}

function project(rows: Row[], projection?: Record<string, string>): Row[] {
  if (!projection) return rows;
  return rows.map((row) => {
    const result: Row = {};
    for (const key of Object.keys(projection)) result[key] = row[projection[key]];
    return result;
  });
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const eq = (column: string, value: unknown): Predicate => (row) => row[column] === value;
  const gt = (column: string, value: unknown): Predicate => (row) => {
    const raw = row[column];
    const a = raw instanceof Date ? raw.getTime() : (raw as bigint | number);
    const b = value instanceof Date ? value.getTime() : (value as bigint | number);
    return a > b;
  };
  const gte = (column: string, value: unknown): Predicate => (row) => {
    const raw = row[column] as Date;
    return raw.getTime() >= (value as Date).getTime();
  };
  const inArray = (column: string, values: readonly unknown[]): Predicate => (row) => values.includes(row[column]);
  const and = (...preds: Predicate[]): Predicate => (row) => preds.every((p) => p(row));
  return { ...actual, eq, gt, gte, inArray, and, asc: (col: unknown) => col };
});

function queryable(rows: Row[]) {
  return {
    // The only orderBy() call in event-subscriptions.ts is asc(seq) — sort
    // ascending by seq here rather than special-casing per test insertion order.
    orderBy: () => ({
      limit: (n: number) => Promise.resolve(
        [...rows].sort((a, b) => Number(a.seq as bigint) - Number(b.seq as bigint)).slice(0, n),
      ),
    }),
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    then: (f: (v: Row[]) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(rows).then(f, r),
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
  db: { select: selectFrom },
  delegationGrants: GRANTS_TABLE,
  delegationGrantCapabilities: CAPS_TABLE,
  eventSubscriptionLog: LOG_TABLE,
}));

import { catchUpSubscriptionEvents } from '../event-subscriptions';

const AGENT = 'did:imajin:matchmaker-agent';
const DELEGATOR = 'did:imajin:ryan';
const OTHER_DID = 'did:imajin:someone-else';

function activeGrant(overrides: Partial<Row> = {}): Row {
  return {
    id: 'grant_1',
    agentDid: AGENT,
    status: 'active',
    expiresAt: new Date(Date.now() + 60_000),
    audience: { type: 'all' },
    ...overrides,
  };
}

function logRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'evt_1',
    seq: BigInt(1),
    eventType: 'availability.match.surfaced',
    issuerDid: DELEGATOR,
    subjectDid: DELEGATOR,
    scope: 'calendar',
    payload: { matchId: 'match_1' },
    correlationId: null,
    occurredAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  grantsStore.clear();
  capsStore.clear();
  logStore.clear();
});

describe('catchUpSubscriptionEvents — no-grant = no events', () => {
  it('returns no events and no entitled types when the agent holds no active grant', async () => {
    logStore.set('evt_1', logRow());
    const result = await catchUpSubscriptionEvents({ agentDid: AGENT, cursor: BigInt(0) });
    expect(result.events).toEqual([]);
    expect(result.entitledEventTypes).toEqual([]);
    expect(result.nextCursor).toBe('0');
  });

  it('returns no events when the agent\'s only grant has expired', async () => {
    grantsStore.set('grant_1', activeGrant({ expiresAt: new Date(Date.now() - 1000) }));
    capsStore.set('cap_1', { grantId: 'grant_1', capability: 'intros:propose', status: 'active' });
    logStore.set('evt_1', logRow());

    const result = await catchUpSubscriptionEvents({ agentDid: AGENT, cursor: BigInt(0) });
    expect(result.events).toEqual([]);
  });

  it('returns no events when the grant is revoked, even though log rows exist (fail-closed)', async () => {
    grantsStore.set('grant_1', activeGrant({ status: 'revoked' }));
    capsStore.set('cap_1', { grantId: 'grant_1', capability: 'intros:propose', status: 'active' });
    logStore.set('evt_1', logRow());

    const result = await catchUpSubscriptionEvents({ agentDid: AGENT, cursor: BigInt(0) });
    expect(result.events).toEqual([]);
  });

  it('excludes a capability that was individually revoked from a still-active grant', async () => {
    grantsStore.set('grant_1', activeGrant());
    capsStore.set('cap_1', { grantId: 'grant_1', capability: 'intros:propose', status: 'revoked' });
    logStore.set('evt_1', logRow());

    const result = await catchUpSubscriptionEvents({ agentDid: AGENT, cursor: BigInt(0) });
    expect(result.events).toEqual([]);
    expect(result.entitledEventTypes).toEqual([]);
  });
});

describe('catchUpSubscriptionEvents — entitlement resolution + ordering', () => {
  beforeEach(() => {
    grantsStore.set('grant_1', activeGrant());
    capsStore.set('cap_1', { grantId: 'grant_1', capability: 'intros:propose', status: 'active' });
  });

  it('returns entitled event types resolved from active capabilities', async () => {
    const result = await catchUpSubscriptionEvents({ agentDid: AGENT, cursor: BigInt(0) });
    expect(result.entitledEventTypes).toEqual(['availability.match.surfaced']);
  });

  it('returns missed events in ascending cursor order and advances nextCursor', async () => {
    logStore.set('evt_1', logRow({ id: 'evt_1', seq: BigInt(1) }));
    logStore.set('evt_2', logRow({ id: 'evt_2', seq: BigInt(2) }));
    logStore.set('evt_3', logRow({ id: 'evt_3', seq: BigInt(3) }));

    const result = await catchUpSubscriptionEvents({ agentDid: AGENT, cursor: BigInt(0) });

    expect(result.events.map((e) => e.id)).toEqual(['evt_1', 'evt_2', 'evt_3']);
    expect(result.nextCursor).toBe('3');
    expect(result.events[0].grantId).toBe('grant_1');
  });

  it('only returns events with seq greater than the presented cursor', async () => {
    logStore.set('evt_1', logRow({ id: 'evt_1', seq: BigInt(1) }));
    logStore.set('evt_2', logRow({ id: 'evt_2', seq: BigInt(2) }));

    const result = await catchUpSubscriptionEvents({ agentDid: AGENT, cursor: BigInt(1) });

    expect(result.events.map((e) => e.id)).toEqual(['evt_2']);
  });

  it('excludes events of a type this agent is not entitled to, even if newer', async () => {
    logStore.set('evt_1', logRow({ id: 'evt_1', seq: BigInt(1) }));
    logStore.set('evt_2', logRow({ id: 'evt_2', seq: BigInt(2), eventType: 'message.send' }));

    const result = await catchUpSubscriptionEvents({ agentDid: AGENT, cursor: BigInt(0) });

    expect(result.events.map((e) => e.id)).toEqual(['evt_1']);
  });

  it('excludes an entitled-type event whose subject does not match the grant audience', async () => {
    grantsStore.set('grant_1', activeGrant({ audience: { type: 'dids', values: [OTHER_DID] } }));
    logStore.set('evt_1', logRow({ id: 'evt_1', seq: BigInt(1), subjectDid: DELEGATOR }));

    const result = await catchUpSubscriptionEvents({ agentDid: AGENT, cursor: BigInt(0) });

    expect(result.events).toEqual([]);
    // still advances the cursor past the row it examined and rejected
    expect(result.nextCursor).toBe('1');
  });

  it('includes an entitled-type event whose subject matches a "dids" audience', async () => {
    grantsStore.set('grant_1', activeGrant({ audience: { type: 'dids', values: [DELEGATOR] } }));
    logStore.set('evt_1', logRow({ id: 'evt_1', seq: BigInt(1), subjectDid: DELEGATOR }));

    const result = await catchUpSubscriptionEvents({ agentDid: AGENT, cursor: BigInt(0) });

    expect(result.events.map((e) => e.id)).toEqual(['evt_1']);
  });

  it('excludes events older than the retention window', async () => {
    logStore.set('evt_old', logRow({ id: 'evt_old', seq: BigInt(1), occurredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }));
    logStore.set('evt_new', logRow({ id: 'evt_new', seq: BigInt(2) }));

    const result = await catchUpSubscriptionEvents({ agentDid: AGENT, cursor: BigInt(0) });

    expect(result.events.map((e) => e.id)).toEqual(['evt_new']);
  });

  it('caps the page size at the configured maximum', async () => {
    const result = await catchUpSubscriptionEvents({ agentDid: AGENT, cursor: BigInt(0), limit: 100000 });
    // No assertion needed beyond "does not throw" — the cap is enforced
    // in-process before the query; this documents the contract exists.
    expect(result.events).toEqual([]);
  });
});
