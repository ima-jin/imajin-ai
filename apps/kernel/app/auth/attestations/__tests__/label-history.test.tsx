import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { attestations, identities, identityMembers } from '@/src/db/schemas/auth';
import AttestationList from '../../components/AttestationList';
import AttestationsPage from '../page';
import { RELATIONSHIP_LABEL_EVENT, relationshipLabelOrgDids } from '../../api/attestations/relationship-label-visibility';

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  getEffectiveDid: vi.fn(),
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  get db() { return mocks.db; },
}));
vi.mock('../../lib/get-effective-did', () => ({ getEffectiveDid: mocks.getEffectiveDid }));
vi.mock('../components/CreateDocumentForm', () => ({ default: () => null }));
vi.mock('../components/DocumentList', () => ({ default: () => null }));
vi.mock('../components/DocumentSigningCard', () => ({ default: () => null }));

const pg = new PGlite();
const database = drizzle(pg);
const ORG = 'did:imajin:org';
const VIEWER = 'did:imajin:viewer';
const PRIVATE_LABEL = 'private-client-label';

beforeAll(async () => {
  mocks.db = database;
  await pg.exec('CREATE SCHEMA auth');
  for (const table of [attestations, identities, identityMembers]) {
    const config = getTableConfig(table);
    const columns = config.columns.map(column => `"${column.name}" ${column.getSQLType()}`);
    await pg.exec(`CREATE TABLE auth."${config.name}" (${columns.join(', ')})`);
  }
});
beforeEach(async () => {
  await pg.exec('TRUNCATE auth.attestations, auth.identities, auth.identity_members');
  mocks.getEffectiveDid.mockResolvedValue({ sessionDid: VIEWER, effectiveDid: ORG });
  await database.insert(attestations).values([
    {
      id: 'label', issuerDid: 'did:imajin:node', subjectDid: ORG,
      type: RELATIONSHIP_LABEL_EVENT, signature: 'test-signature',
      payload: { newLabel: PRIVATE_LABEL }, issuedAt: new Date('2026-10-19'),
    },
    {
      id: 'ordinary', issuerDid: VIEWER, subjectDid: ORG,
      type: 'vouch', signature: 'test-signature', issuedAt: new Date('2026-10-18'),
    },
  ]);
});
afterAll(async () => { await pg.close(); });

async function renderList(searchParams: { type?: string; role?: string } = {}) {
  // Resolve the page's async child as the RSC renderer does. This also pins
  // the real viewer/effective-org wiring instead of supplying test-only props.
  const page = await AttestationsPage({ searchParams: Promise.resolve(searchParams) });
  const list = page.props.children.at(-1);
  expect(list.type).toBe(AttestationList);
  expect(list.props.viewerDid).toBe(VIEWER);
  expect(list.props.sessionDid).toBe(ORG);
  return renderToStaticMarkup(await AttestationList(list.props));
}

describe('/auth/attestations label-history authorization (#2977)', () => {
  it.each(['owner', 'admin'])('keeps label history visible to a live %s', async role => {
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: VIEWER, role });
    const html = await renderList();
    expect(html).toContain(RELATIONSHIP_LABEL_EVENT);
    expect(html).toContain(PRIVATE_LABEL);
    expect(html).toContain('vouch');
  });

  it.each(['member', 'maintainer', 'agent'])('hides label history from a plain %s without an empty/error panel', async role => {
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: VIEWER, role });
    const html = await renderList();
    expect(html).not.toContain(RELATIONSHIP_LABEL_EVENT);
    expect(html).not.toContain(PRIVATE_LABEL);
    expect(html).not.toContain('No attestations found');
    expect(html).not.toContain('error');
    expect(html).toContain('vouch');
  });

  it('does not trust act-as identity or an owner membership in another org', async () => {
    await database.insert(identityMembers).values([
      { identityDid: ORG, memberDid: ORG, role: 'owner' },
      { identityDid: 'did:imajin:other-org', memberDid: VIEWER, role: 'owner' },
    ]);
    expect(await renderList()).not.toContain(PRIVATE_LABEL);
  });

  it('reads role downgrade and removal live on each render', async () => {
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: VIEWER, role: 'owner' });
    expect(await renderList()).toContain(PRIVATE_LABEL);
    await database.update(identityMembers).set({ role: 'member' }).where(eq(identityMembers.memberDid, VIEWER));
    expect(await renderList()).not.toContain(PRIVATE_LABEL);
    await database.update(identityMembers).set({ role: 'admin', removedAt: new Date() }).where(eq(identityMembers.memberDid, VIEWER));
    expect(await renderList()).not.toContain(PRIVATE_LABEL);
  });

  it('cannot bypass visibility with an explicit label-type filter', async () => {
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: VIEWER, role: 'member' });
    const html = await renderList({ type: RELATIONSHIP_LABEL_EVENT, role: 'subject' });
    expect(html).not.toContain(PRIVATE_LABEL);
    expect(html).not.toContain('Signed payload');
  });

  it('excludes hidden history before pagination rather than producing an empty page or next link', async () => {
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: VIEWER, role: 'member' });
    await database.insert(attestations).values(Array.from({ length: 25 }, (_, index) => ({
      id: `label-${index}`, issuerDid: ORG, subjectDid: ORG,
      type: RELATIONSHIP_LABEL_EVENT, signature: 'test-signature',
      payload: { newLabel: PRIVATE_LABEL }, issuedAt: new Date('2026-10-20'),
    })));
    const html = await renderList();
    expect(html).toContain('vouch');
    expect(html).not.toContain(PRIVATE_LABEL);
    expect(html).not.toContain('No attestations found');
    expect(html).not.toContain('Next');
  });

  it('does not query membership without a viewer or candidate org', async () => {
    expect(await relationshipLabelOrgDids(null, [ORG])).toEqual([]);
    expect(await relationshipLabelOrgDids(VIEWER, [])).toEqual([]);
  });
});
