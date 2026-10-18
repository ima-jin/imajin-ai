import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { canonicalize, type Identity } from '@imajin/auth';
import * as schema from '@/src/db/schemas/auth';

const mocks = vi.hoisted(() => ({ db: null as unknown, auth: vi.fn(), directory: vi.fn() }));
vi.mock('@/src/lib/kernel/app-nav', () => ({ resolveAppDirectoryForIdentity: mocks.directory }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'), get db() { return mocks.db; },
}));
vi.mock('@imajin/auth', async (original) => ({
  ...await original<typeof import('@imajin/auth')>(), requireAuth: mocks.auth,
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@/src/lib/auth/require-internal-api-key', () => ({ requireInternalApiKey: vi.fn() }));

import { DELETE, PATCH, GET } from '@/app/auth/api/groups/[groupDid]/controllers/[controllerDid]/route';
import { POST } from '@/app/auth/api/groups/[groupDid]/controllers/route';

const pg = new PGlite();
const database = drizzle(pg, { schema });
const keys = generateKeyPairSync('ed25519');
const groupDid = 'did:imajin:group';
const owner = 'did:imajin:owner';
const member = 'did:imajin:member';
const stranger = 'did:imajin:stranger';
const params = (controllerDid = member) => ({ params: Promise.resolve({ groupDid, controllerDid }) });
function as(id: string, extra: Partial<Identity> = {}) {
  mocks.auth.mockResolvedValue({ identity: { id, scope: 'actor', ...extra } });
}
function request(method: string, body?: unknown) {
  return new NextRequest('http://localhost/auth/api/groups/group/controllers/member', {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

}
function edit(body: unknown, did = member) { return PATCH(request('PATCH', body), params(did)); }
function add(did = stranger) {
  return POST(request('POST', { did, role: 'member' }), { params: Promise.resolve({ groupDid }) });
}
function rows() { return database.select().from(schema.identityMembers); }
async function evidence() {
  const records = await database.select().from(schema.attestations);
  for (const record of records) {
    const signed = canonicalize({
      subject_did: record.subjectDid, type: record.type, context_id: record.contextId,
      context_type: record.contextType, payload: record.payload, issued_at: record.issuedAt.getTime(),
    });
    expect(verify(null, Buffer.from(signed), keys.publicKey, Buffer.from(record.signature, 'hex'))).toBe(true);
    expect(record.attestationStatus).toBeNull();
  }
  return records;
}
beforeAll(async () => {
  mocks.db = database;
  await pg.exec('CREATE SCHEMA auth;');
  for (const table of [schema.identities, schema.identityMembers, schema.attestations]) {
    const config = getTableConfig(table);
    const columns = config.columns.map((column) => `"${column.name}" ${column.getSQLType()}`);
    await pg.exec(`CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(', ')});`);
  }
});
beforeEach(async () => {
  mocks.directory.mockResolvedValue([]);
  await pg.exec('TRUNCATE auth.identities, auth.identity_members, auth.attestations');
  await database.insert(schema.identities).values({ id: groupDid, scope: 'business', publicKey: groupDid });
  await database.insert(schema.identityMembers).values([
    { identityDid: groupDid, memberDid: owner, role: 'owner', addedVia: 'direct' },
    { identityDid: groupDid, memberDid: member, role: 'member', addedBy: owner, addedVia: 'direct' },
  ]);
  vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex'));
  as(owner);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await pg.close(); });

describe('editable membership and signed history (#2946)', () => {
  it('promotes/demotes in place, records the real actor and act-as, and never rewrites history or provenance', async () => {
    const before = (await rows()).find((row) => row.memberDid === member)!;
    expect((await edit({ role: 'admin' })).status).toBe(200);
    const [first] = await evidence();
    expect(first).toMatchObject({
      type: 'group.member.role.changed', subjectDid: member, contextId: groupDid,
      payload: { memberDid: member, oldRole: 'member', newRole: 'admin', by: owner, actingAs: null, actingFor: null },
    });
    as(owner, { actingAs: groupDid });
    expect((await edit({ role: 'maintainer' })).status).toBe(200);
    const records = await evidence();
    expect(records).toHaveLength(2);
    expect(records.find((row) => row.id === first.id)).toEqual(first);
    expect(records.find((row) => row.id !== first.id)?.payload).toMatchObject({
      oldRole: 'admin', newRole: 'maintainer', by: owner, actingAs: groupDid,
    });
    expect((await rows()).find((row) => row.memberDid === member)).toMatchObject({
      role: 'maintainer', addedBy: before.addedBy, addedVia: before.addedVia, addedAt: before.addedAt, removedAt: null,
    });
    expect(await rows()).toHaveLength(2);
  });

  it('edits agent service scope in place; no-op emits nothing and next internal read sees the narrowed list', async () => {
    expect((await edit({ role: 'agent', allowedServices: ['media', 'pay'] })).status).toBe(200);
    expect((await edit({ allowedServices: ['pay', 'pay'] })).status).toBe(200);
    const records = await evidence();
    expect(records).toHaveLength(2);
    expect(records[1].payload).toMatchObject({
      oldRole: 'agent', newRole: 'agent', oldAllowedServices: ['media', 'pay'], allowedServices: ['pay'],
    });
    expect(await (await edit({ allowedServices: ['pay'] })).json()).toMatchObject({ changed: false });
    expect(await evidence()).toHaveLength(2);
    expect(await (await GET(request('GET'), params())).json()).toMatchObject({
      valid: true, role: 'agent', allowedServices: ['pay'],
    });
    expect((await edit({ allowedServices: [] })).status).toBe(400);
    expect((await edit({ allowedServices: null })).status).toBe(200);
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: member, allowedServices: null }));
    expect((await edit({ role: 'member', allowedServices: ['media'] })).status).toBe(200);
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: member, role: 'member', allowedServices: ['media'] }));
  });

  it.each(['admin', 'maintainer', 'member', 'agent'])('persists and signs %s scopes, preserves omitted scope and restores full access', async (role) => {
    expect((await edit({ role, allowedServices: ['pay', 'pay'] })).status).toBe(200);
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: member, role, allowedServices: ['pay'] }));
    expect((await evidence())[0].payload).toMatchObject({ oldAllowedServices: null, allowedServices: ['pay'] });
    expect(await (await edit({ role })).json()).toMatchObject({ changed: false, allowedServices: ['pay'] });
    expect((await edit({ role: 'maintainer' })).status).toBe(200);
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: member, allowedServices: ['pay'] }));
    expect((await edit({ allowedServices: null })).status).toBe(200);
    const records = await evidence();
    expect(records.at(-1)?.payload).toMatchObject({ oldAllowedServices: ['pay'], allowedServices: null });
  });

  it.each(['admin', 'maintainer', 'member', 'agent'])('adds a scoped %s with verifiable evidence', async (role) => {
    const response = await POST(request('POST', { did: stranger, role, allowedServices: ['pay'] }), {
      params: Promise.resolve({ groupDid }),
    });
    expect(response.status).toBe(201);
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: stranger, role, allowedServices: ['pay'] }));
    const [record] = await evidence();
    expect(record.payload).toMatchObject({ role, oldAllowedServices: null, allowedServices: ['pay'], by: owner });
  });

  it('downgrade applies on the next call even with stale session role claims', async () => {
    await edit({ role: 'admin', allowedServices: ['pay'] });
    as(member, { actingAs: groupDid, actingAsRole: 'admin' });
    expect((await edit({ role: 'member' })).status).toBe(200);
    expect((await edit({ role: 'admin' })).status).toBe(403);
    expect((await add()).status).toBe(403);
    expect(await (await GET(request('GET'), params())).json()).toMatchObject({ valid: true, role: 'member' });
    expect(await evidence()).toHaveLength(2);
  });
  it('keeps the authenticated principal distinct from the delegated group in signed evidence', async () => {
    as(owner, { actingFor: groupDid });
    expect((await edit({ role: 'maintainer' })).status).toBe(200);
    const [record] = await evidence();
    expect(record.payload).toMatchObject({ by: owner, memberDid: member, actingFor: groupDid, actingAs: null });
  });

  it('adds/removes plain members with exactly one verifiable member-named event each and preserves history', async () => {
    expect((await add()).status).toBe(201);
    const [first] = await evidence();
    expect(first).toMatchObject({ type: 'group.member.added', subjectDid: stranger, payload: { role: 'member', by: owner } });
    as(owner, { actingAs: groupDid });
    expect((await DELETE(request('DELETE'), params(stranger))).status).toBe(200);
    const records = await evidence();
    expect(records).toHaveLength(2);
    expect(records.find((row) => row.id === first.id)).toEqual(first);
    expect(records.find((row) => row.id !== first.id)).toMatchObject({
      type: 'group.member.removed', subjectDid: stranger,
      payload: { role: 'member', by: owner, actingAs: groupDid, memberDid: stranger },
    });
    expect((await edit({ role: 'admin' }, stranger)).status).toBe(404);
    expect(await evidence()).toHaveLength(2);
    expect((await add()).status).toBe(201);
    expect(await evidence()).toHaveLength(3);
  });

  it.each([stranger, member])('rejects non-manager %s without events', async (did) => {
    as(did);
    expect((await edit({ role: 'admin' })).status).toBe(403);
    expect(await evidence()).toHaveLength(0);
  });

  it('enforces admin add/remove boundaries and reserves all owner mutations to ownership transfer', async () => {
    await edit({ role: 'admin', allowedServices: ['pay'] });
    as(member);
    expect((await edit({ role: 'member' }, owner)).status).toBe(400);
    as(owner);
    expect((await edit({ role: 'owner' })).status).toBe(400);
    expect((await edit({ role: 'member' }, owner)).status).toBe(400);
    await database.insert(schema.identityMembers).values({ identityDid: groupDid, memberDid: stranger, role: 'member' });
    as(member);
    expect((await edit({ role: 'admin' }, stranger)).status).toBe(403);
    expect((await edit({ role: 'maintainer', allowedServices: ['pay'] }, stranger)).status).toBe(200);
    expect((await edit({ role: 'member' }, stranger)).status).toBe(403);
    expect((await edit({ role: 'maintainer' })).status).toBe(200);
    expect((await rows()).filter((row) => row.role === 'owner')).toHaveLength(1);
  });

  it.each([null, [], {}, { role: 'owner' }, { role: 'superuser' }, { role: 4 },
    { allowedServices: 'media' }, { allowedServices: [4] }, { allowedServices: [''] },
    { allowedServices: [] }, { allowedServices: ['made-up'] }, { allowedServices: ['pay', 'unknown'] },
    { addedBy: stranger }, { role: null }])('rejects malformed update %j', async (body) => {
    expect((await edit(body)).status).toBe(400);
    expect(await evidence()).toHaveLength(0);
  });

  it('handles missing target/group, removed caller, suspended group, bad JSON and unauthenticated calls', async () => {
    expect((await edit({ role: 'member' }, stranger)).status).toBe(404);
    mocks.auth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });
    expect((await edit({ role: 'admin' })).status).toBe(401);
    expect((await PATCH(new NextRequest('http://localhost', { method: 'PATCH', body: '{' }), params())).status).toBe(400);
    await database.update(schema.identities).set({ suspendedAt: new Date() }).where(eq(schema.identities.id, groupDid));
    expect((await edit({ role: 'admin' })).status).toBe(403);
    await database.update(schema.identities).set({ suspendedAt: null }).where(eq(schema.identities.id, groupDid));
    await database.update(schema.identityMembers).set({ removedAt: new Date() }).where(eq(schema.identityMembers.memberDid, owner));
    expect((await edit({ role: 'admin' })).status).toBe(403);
    await database.delete(schema.identities).where(eq(schema.identities.id, groupDid));
    expect((await edit({ role: 'admin' })).status).toBe(404);
    expect(await evidence()).toHaveLength(0);
  });

  it('rolls back add/edit/remove if evidence insertion fails; missing signing material fails closed too', async () => {
    await pg.exec(`ALTER TABLE auth.attestations ADD CONSTRAINT reject_member CHECK (type NOT LIKE 'group.member.%')`);
    try {
      expect((await edit({ role: 'admin' })).status).toBe(500);
      expect((await DELETE(request('DELETE'), params())).status).toBe(500);
      expect((await add()).status).toBe(500);
      expect(await rows()).toHaveLength(2);
      expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: member, role: 'member', removedAt: null }));
      expect(await evidence()).toHaveLength(0);
    } finally {
      await pg.exec('ALTER TABLE auth.attestations DROP CONSTRAINT reject_member');
    }
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    expect((await edit({ role: 'admin' })).status).toBe(500);
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: member, role: 'member' }));
  });

  it('serializes duplicate edits so one transition creates one event', async () => {
    const responses = await Promise.all([edit({ role: 'admin' }), edit({ role: 'admin' })]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await evidence()).toHaveLength(1);
  });
});

describe('non-owner service-grant boundaries (#2956 sent-back)', () => {
  async function restrictedAdmin(allowedServices = ['pay']) {
    expect((await edit({ role: 'admin', allowedServices })).status).toBe(200);
    as(member, { actingAsServices: ['pay', 'media', 'connections'] });
  }
  function addScoped(allowedServices?: string[] | null) {
    return POST(request('POST', { did: stranger, role: 'member', allowedServices }), {
      params: Promise.resolve({ groupDid }),
    });
  }

  it.each(['member', 'maintainer', 'agent'])('refuses self-demotion to %s with wider services, but preserves omitted restrictions', async (role) => {
    await restrictedAdmin();
    for (const allowedServices of [null, ['pay', 'connections']]) {
      expect((await edit({ role, allowedServices })).status).toBe(403);
    }
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: member, role: 'admin', allowedServices: ['pay'] }));
    expect(await evidence()).toHaveLength(1);
    expect((await edit({ role })).status).toBe(200);
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: member, role, allowedServices: ['pay'] }));
  });

  it('requires a subset of both the target scope and the live caller scope', async () => {
    await restrictedAdmin(['pay', 'media']);
    await database.insert(schema.identityMembers).values({
      identityDid: groupDid, memberDid: stranger, role: 'member', allowedServices: ['pay'],
    });
    for (const allowedServices of [null, ['pay', 'media'], ['connections']]) {
      expect((await edit({ allowedServices }, stranger)).status).toBe(403);
    }
    expect(await evidence()).toHaveLength(1);
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: stranger, allowedServices: ['pay'] }));
    expect(await (await edit({ allowedServices: ['pay'] }, stranger)).json()).toMatchObject({ changed: false });
    as(owner);
    await edit({ allowedServices: ['pay', 'connections'] }, stranger);
    as(member);
    expect((await edit({ allowedServices: ['connections'] }, stranger)).status).toBe(403);
    expect((await edit({ allowedServices: ['pay'] }, stranger)).status).toBe(200);
  });

  it.each([undefined, null, ['connections'], ['pay', 'connections']].map((services) => ({ services })))('refuses restricted-admin add with $services without evidence', async ({ services }) => {
    await restrictedAdmin();
    expect((await addScoped(services)).status).toBe(403);
    expect(await rows()).toHaveLength(2);
    expect(await evidence()).toHaveLength(1);
  });

  it('applies caller subsets to re-adds and allows finite in-scope add/re-add', async () => {
    await restrictedAdmin();
    expect((await addScoped(['pay'])).status).toBe(201);
    as(owner);
    expect((await DELETE(request('DELETE'), params(stranger))).status).toBe(200);
    const before = await rows();
    const records = await evidence();
    as(member);
    for (const allowedServices of [null, ['connections']]) {
      expect((await addScoped(allowedServices)).status).toBe(403);
      expect(await rows()).toEqual(before);
      expect(await evidence()).toEqual(records);
    }
    expect((await addScoped(['pay'])).status).toBe(201);
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: stranger, allowedServices: ['pay'], removedAt: null }));
  });

  it('reserves All services grants to owners even when an admin is unrestricted', async () => {
    await edit({ role: 'admin' });
    as(member);
    expect((await addScoped(null)).status).toBe(403);
    as(owner);
    expect((await addScoped(['pay'])).status).toBe(201);
    as(member);
    expect((await edit({ allowedServices: null }, stranger)).status).toBe(403);
    expect((await edit({ allowedServices: ['pay', 'media'] }, stranger)).status).toBe(403);
  });

  it('allows the owner to widen/edit any non-owner scope and add/re-add All services', async () => {
    await edit({ role: 'admin', allowedServices: ['pay'] });
    expect((await edit({ role: 'maintainer', allowedServices: ['connections'] })).status).toBe(200);
    expect((await edit({ allowedServices: null })).status).toBe(200);
    expect((await addScoped(['connections'])).status).toBe(201);
    expect((await edit({ allowedServices: null }, stranger)).status).toBe(200);
    expect((await DELETE(request('DELETE'), params(stranger))).status).toBe(200);
    expect((await addScoped(null)).status).toBe(201);
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: stranger, allowedServices: null, removedAt: null }));
    await evidence();
  });

  it('adds and saves existing registry-only agent scopes using the available group directory', async () => {
    mocks.directory.mockResolvedValue([
      { slug: 'registry-only', name: 'Registry App', available: true },
      { slug: 'unavailable-app', name: 'Unavailable', available: false },
    ]);
    const added = await POST(request('POST', { did: stranger, role: 'agent', allowedServices: ['registry-only'] }), {
      params: Promise.resolve({ groupDid }),
    });
    expect(added.status).toBe(201);
    expect(await (await edit({ allowedServices: ['registry-only'] }, stranger)).json()).toMatchObject({
      changed: false, allowedServices: ['registry-only'],
    });
    expect((await edit({ allowedServices: ['registry-only', 'pay'] }, stranger)).status).toBe(200);
    expect((await edit({ allowedServices: ['unavailable-app'] }, stranger)).status).toBe(400);
    expect(mocks.directory).toHaveBeenCalledWith(groupDid);
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: stranger, role: 'agent', allowedServices: ['pay', 'registry-only'] }));
    await evidence();
  });
});
