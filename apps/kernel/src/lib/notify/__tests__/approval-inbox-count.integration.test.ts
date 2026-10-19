import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { operatorApprovals } from '@/src/db/schemas/operator-approvals';
import { resolveApprovalAddressee } from '../approval-addressing';
import { countInboxApprovals } from '../approval-inbox-count';
import { OPERATOR_APPROVALS_TABLE_SQL } from '@/src/lib/jin/__tests__/pglite-record-events-harness';

const state = vi.hoisted(() => ({ db: null as unknown, queries: [] as string[] }));
vi.mock('@/src/db', async () => {
  const schema = await import('@/src/db/schemas/operator-approvals');
  return { operatorApprovals: schema.operatorApprovals, get db() { return state.db; } };
});

let database: PGlite;
const operator = 'did:imajin:operator';
const owner = 'did:imajin:owner';
const group = 'did:imajin:group';

beforeAll(async () => {
  database = new PGlite();
  await database.waitReady;
  await database.exec(`CREATE SCHEMA operator; ${OPERATOR_APPROVALS_TABLE_SQL}`);
  state.db = drizzle(database, { logger: { logQuery: query => { state.queries.push(query); } } });
}, 30_000);
beforeEach(async () => {
  await database.exec('TRUNCATE operator.approvals');
  state.queries = [];
});
afterAll(async () => database.close());

async function seed(rows: Partial<typeof operatorApprovals.$inferInsert>[]) {
  await drizzle(database).insert(operatorApprovals).values(rows.map((row, i) => ({
    proposalId: `proposal-${i}`, operatorDid: operator, source: 'system-agent',
    kind: 'system-agent:restart', summary: 'Test', status: 'pending', ...row,
  })));
}

describe('single-query durable Inbox count', () => {
  it('counts 100 Reach + 20 knocks without hydrating any payload or writing', async () => {
    await seed([
      ...Array.from({ length: 100 }, () => ({ source: 'reach', kind: 'reach:message' })),
      ...Array.from({ length: 20 }, () => ({ source: 'knock', kind: 'knock:request' })),
      { status: 'applied', detail: { gateRules: 'never-return', unpublishedTopics: ['private-topic'] } },
    ]);
    expect(await countInboxApprovals(operator)).toEqual({ pending: 120, total: 121 });
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]).toMatch(/^select count\(\*\) filter/i);
    expect(state.queries[0]).not.toMatch(/\b(insert|update|delete)\b/i);
    state.queries = [];
    expect(await countInboxApprovals(owner)).toEqual({ pending: 0, total: 0 });
    expect(state.queries).toHaveLength(1);
  });

  it('matches canonical addressing, including misrouted legacy connectors and malformed owner values', async () => {
    const rows = [
      { kind: 'github:mutate', detail: { ownerDid: owner } },
      { kind: 'new-connector:write', detail: { ownerDid: owner }, status: 'applied' },
      { kind: 'github:append', detail: { ownerDid: owner } },
      { kind: 'Github:mutate', detail: { ownerDid: owner } },
      { kind: 'github:read', detail: { ownerDid: owner } },
      { kind: 'github:mutate', detail: { ownerDid: 'not-a-did' } },
      { kind: 'github:mutate', detail: { ownerDid: 7 } },
      { kind: 'github:mutate', detail: { ownerDid: ['did:imajin:owner'] } },
      { kind: 'github:mutate', detail: null },
      { operatorDid: owner, kind: 'github:mutate', detail: { ownerDid: operator } },
      { operatorDid: owner, source: 'decision', kind: 'decision:card', status: 'denied' },
    ];
    await seed(rows);
    for (const did of [operator, owner, group]) {
      const expected = rows.filter(row => resolveApprovalAddressee(row, row.operatorDid ?? operator) === did);
      expect(await countInboxApprovals(did)).toEqual({
        pending: expected.filter(row => !row.status || row.status === 'pending').length, total: expected.length,
      });
    }
  });

  it('includes only verified shared Reach/knock kinds, once, with optional source filtering', async () => {
    await seed([
      { operatorDid: owner },
      { operatorDid: group, source: 'reach', kind: 'reach:message' },
      { operatorDid: group, source: 'knock', kind: 'knock:request' },
      { operatorDid: group, source: 'reach', kind: 'reach:other' },
      { operatorDid: group },
    ]);
    expect(await countInboxApprovals(owner)).toEqual({ pending: 1, total: 1 });
    expect(await countInboxApprovals(owner, { sharedReachPrincipal: group })).toEqual({ pending: 3, total: 3 });
    expect(await countInboxApprovals(owner, { sharedReachPrincipal: group, source: 'knock' })).toEqual({ pending: 1, total: 1 });
    expect(await countInboxApprovals(group, { sharedReachPrincipal: group })).toEqual({ pending: 4, total: 4 });
    expect(await countInboxApprovals(owner, { source: 'absent' })).toEqual({ pending: 0, total: 0 });
  });
});
