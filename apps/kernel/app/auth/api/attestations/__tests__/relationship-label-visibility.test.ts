import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { identityMembers } from '@/src/db/schemas/auth';
import type { Attestation } from '@/src/db';

const mocks = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  get db() { return mocks.db; },
}));
import { filterRelationshipLabelEvents } from '../relationship-label-visibility';

const pg = new PGlite();
const database = drizzle(pg);
const ORG = 'did:imajin:org';
const OTHER_ORG = 'did:imajin:other-org';
const VIEWER = 'did:imajin:viewer';
const privateRow = {
  id: 'label-change', type: 'connection.relationship.label.changed',
  subjectDid: ORG, issuerDid: 'did:imajin:node',
  disclosureScope: 'public', // A registry/config change must never publish it.
  payload: { counterpartyDid: VIEWER, oldLabel: null, newLabel: 'client' },
} as unknown as Attestation;
const legacyRow = { id: 'legacy', type: 'vouch', subjectDid: ORG } as Attestation;
const resolveViewer = async () => VIEWER;

beforeAll(async () => {
  mocks.db = database;
  const config = getTableConfig(identityMembers);
  await pg.exec('CREATE SCHEMA auth');
  const columns = config.columns.map(column => `"${column.name}" ${column.getSQLType()}`);
  await pg.exec(`CREATE TABLE auth.identity_members (${columns.join(', ')})`);
});
beforeEach(async () => { await pg.exec('TRUNCATE auth.identity_members'); });
afterAll(async () => { await pg.close(); });

describe('private relationship event visibility (#2945)', () => {
  it('leaves legacy reads unchanged without authenticating or querying membership', async () => {
    const resolve = vi.fn();
    expect(await filterRelationshipLabelEvents([legacyRow], resolve)).toEqual([legacyRow]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('hides the label from anonymous callers while keeping unrelated legacy events', async () => {
    expect(await filterRelationshipLabelEvents([privateRow, legacyRow], async () => null)).toEqual([legacyRow]);
  });

  it('hides the org-side label from the counterparty named in the signed payload', async () => {
    expect(await filterRelationshipLabelEvents([privateRow], resolveViewer)).toEqual([]);
  });

  it.each(['owner', 'admin'])('shows the private record to a live %s, including direct controller sessions', async role => {
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: VIEWER, role });
    expect(await filterRelationshipLabelEvents([privateRow], resolveViewer)).toEqual([privateRow]);
  });

  it.each(['maintainer', 'member', 'agent'])('does not mistake %s membership for management authority', async role => {
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: VIEWER, role });
    expect(await filterRelationshipLabelEvents([privateRow], resolveViewer)).toEqual([]);
  });

  it('reads membership live after downgrade and removal', async () => {
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: VIEWER, role: 'owner' });
    expect(await filterRelationshipLabelEvents([privateRow], resolveViewer)).toEqual([privateRow]);
    await database.update(identityMembers).set({ role: 'member' }).where(eq(identityMembers.memberDid, VIEWER));
    expect(await filterRelationshipLabelEvents([privateRow], resolveViewer)).toEqual([]);
    await database.update(identityMembers).set({ role: 'admin', removedAt: new Date() }).where(eq(identityMembers.memberDid, VIEWER));
    expect(await filterRelationshipLabelEvents([privateRow], resolveViewer)).toEqual([]);
  });

  it('does not expose a different org book even to an owner of this org', async () => {
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: VIEWER, role: 'owner' });
    const other = { ...privateRow, id: 'other-org-record', subjectDid: OTHER_ORG };
    expect(await filterRelationshipLabelEvents([privateRow, other], resolveViewer)).toEqual([privateRow]);
  });

  it('fails closed on a membership store failure', async () => {
    mocks.db = { select: () => { throw new Error('store unavailable'); } };
    try {
      await expect(filterRelationshipLabelEvents([privateRow], resolveViewer)).rejects.toThrow('store unavailable');
    } finally {
      mocks.db = database;
    }
  });
});
