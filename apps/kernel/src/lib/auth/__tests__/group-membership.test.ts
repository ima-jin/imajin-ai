/**
 * Unit tests for the #1851 read-side `identity_members` fallback
 * (`isActiveGroupMember`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eqPredicate, isNullPredicate, andPredicate, type Row, type Predicate } from './drizzle-predicate-mocks';

const { identitiesStore, membersStore, IDENTITIES_TABLE, MEMBERS_TABLE } = vi.hoisted(() => {
  const identitiesStore = new Map<string, Row>();
  const membersStore = new Map<string, Row>();
  const IDENTITIES_TABLE = { __table: 'identities', id: 'id', scope: 'scope' };
  const MEMBERS_TABLE = {
    __table: 'members',
    identityDid: 'identityDid',
    memberDid: 'memberDid',
    removedAt: 'removedAt',
  };
  return { identitiesStore, membersStore, IDENTITIES_TABLE, MEMBERS_TABLE };
});

function storeFor(table: { __table: string }): Map<string, Row> {
  return table.__table === 'identities' ? identitiesStore : membersStore;
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, eq: eqPredicate, isNull: isNullPredicate, and: andPredicate };
});

function projectRow(row: Row, projection: Record<string, string>): Row {
  const out: Row = {};
  for (const key of Object.keys(projection)) out[key] = row[projection[key]];
  return out;
}

function runLimit(table: { __table: string }, predicate: Predicate, n: number, projection?: Record<string, string>) {
  const rows = [...storeFor(table).values()].filter(predicate).slice(0, n);
  if (!projection) return Promise.resolve(rows);
  return Promise.resolve(rows.map((row) => projectRow(row, projection)));
}

function selectFrom(projection?: Record<string, string>) {
  return {
    from: (table: { __table: string }) => ({
      where: (predicate: Predicate) => ({
        limit: (n: number) => runLimit(table, predicate, n, projection),
      }),
    }),
  };
}

vi.mock('@/src/db', () => ({
  db: { select: selectFrom },
  identities: IDENTITIES_TABLE,
  identityMembers: MEMBERS_TABLE,
}));

import { isActiveGroupMember } from '../group-membership';

const ORG = 'did:imajin:Fp5QtWo9vsmS7G5AcbuEUrPT6oGbKxj5gke6T4voH7xE';
const PERSONAL = 'did:imajin:ryan';
const MEMBER = 'did:imajin:member';
const STRANGER = 'did:imajin:stranger';

function identity(did: string, scope: string): Row {
  return { id: did, scope };
}

function membership(overrides: Row = {}): Row {
  return { identityDid: ORG, memberDid: MEMBER, removedAt: null, ...overrides };
}

beforeEach(() => {
  identitiesStore.clear();
  membersStore.clear();
});

describe('isActiveGroupMember', () => {
  it('(a) an active identity_members row on a business-scope owner grants read', async () => {
    identitiesStore.set(ORG, identity(ORG, 'business'));
    membersStore.set('m1', membership());

    await expect(isActiveGroupMember(ORG, MEMBER)).resolves.toBe(true);
  });

  it('grants read for community- and family-scope owners too', async () => {
    identitiesStore.set(ORG, identity(ORG, 'community'));
    membersStore.set('m1', membership());
    await expect(isActiveGroupMember(ORG, MEMBER)).resolves.toBe(true);

    identitiesStore.set(ORG, identity(ORG, 'family'));
    await expect(isActiveGroupMember(ORG, MEMBER)).resolves.toBe(true);
  });

  it('(b) denies a DID with no membership row on the org', async () => {
    identitiesStore.set(ORG, identity(ORG, 'business'));
    membersStore.set('m1', membership());

    await expect(isActiveGroupMember(ORG, STRANGER)).resolves.toBe(false);
  });

  it('denies a removed (departed) member', async () => {
    identitiesStore.set(ORG, identity(ORG, 'business'));
    membersStore.set('m1', membership({ removedAt: new Date() }));

    await expect(isActiveGroupMember(ORG, MEMBER)).resolves.toBe(false);
  });

  it('(c) a personal (actor-scope) owner is unaffected even with a matching identity_members row', async () => {
    // Mirrors the X-Acting-For agent-delegation bootstrap (role='agent') on
    // a personal identity — that membership must never grant a non-owner
    // read access to the personal identity's own private assets.
    identitiesStore.set(PERSONAL, identity(PERSONAL, 'actor'));
    membersStore.set('m1', { identityDid: PERSONAL, memberDid: MEMBER, removedAt: null });

    await expect(isActiveGroupMember(PERSONAL, MEMBER)).resolves.toBe(false);
  });

  it('fails closed when the owner identity cannot be found', async () => {
    membersStore.set('m1', membership());

    await expect(isActiveGroupMember(ORG, MEMBER)).resolves.toBe(false);
  });
});
