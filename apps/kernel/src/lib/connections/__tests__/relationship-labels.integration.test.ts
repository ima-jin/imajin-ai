import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { canonicalize, type Identity } from '@imajin/auth';
import * as authSchema from '@/src/db/schemas/auth';
import * as connectionSchema from '@/src/db/schemas/connections';

const mocks = vi.hoisted(() => ({ db: null as unknown, auth: vi.fn(), effective: vi.fn(), logError: vi.fn() }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/connections'),
  ...await import('@/src/db/schemas/profile'),
  ...await import('@/src/db/schemas/registry'),
  get db() { return mocks.db; },
}));
vi.mock('@imajin/auth', async (original) => ({
  ...await original<typeof import('@imajin/auth')>(), requireAuth: mocks.auth,
  resolveEffectiveDid: mocks.effective,
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@/src/lib/kernel/lookup', () => ({ lookupIdentity: async () => ({ handle: 'counterparty', name: 'Counterparty' }) }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@imajin/logger', async (original) => ({
  ...await original<typeof import('@imajin/logger')>(),
  createLogger: () => ({ error: mocks.logError, warn: vi.fn(), info: vi.fn() }),
}));
vi.mock('@/src/lib/auth/foreign-agent-stub', () => ({ blockForeignAgentStub: vi.fn() }));

import { PATCH, OPTIONS } from '@/app/connections/api/connections/[did]/route';
import { GET } from '@/app/connections/api/connections/route';
import { GET as ROSTER, PATCH as CONFIG } from '@/app/auth/api/groups/[groupDid]/route';
import { GET as FOREST_CONFIG, PATCH as UPDATE_FOREST_CONFIG } from '@/app/profile/api/forest/[groupDid]/config/route';
import { listConnections } from '../list';
import { canManageRelationshipLabels, isRelationshipLabel, setRelationshipLabel } from '../relationship-labels';

const pg = new PGlite();
const database = drizzle(pg, { schema: { ...authSchema, ...connectionSchema } });
const { identities, identityMembers, attestations } = authSchema;
const { connections, nicknames } = connectionSchema;
const org = 'did:imajin:business';
const owner = 'did:imajin:owner';
const admin = 'did:imajin:admin';
const client = 'did:imajin:client';
const agent = 'did:imajin:agent';
const keys = generateKeyPairSync('ed25519');
const params = (did = client) => ({ params: Promise.resolve({ did }) });

function as(id = owner, extra: Partial<Identity> = {}) {
  mocks.auth.mockResolvedValue({ identity: { id, scope: 'actor', subtype: 'human', ...extra } });
  mocks.effective.mockResolvedValue({
    ok: true, effectiveDid: extra.actingFor ?? extra.actingAs ?? id, via: 'session',
    composedBy: extra.actingFor ? id : null,
  });
}

function request(body?: unknown, method = 'PATCH') {
  return new NextRequest('http://localhost/connections/api/connections/client', {
    method, headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function patch(body: unknown, did = client) {
  const response = await PATCH(request(body), params(did));
  return { status: response.status, body: await response.json() };
}

const connectionRows = () => database.select().from(connections);
const auditRows = () => database.select().from(attestations);

beforeAll(async () => {
  mocks.db = database;
  for (const table of [identities, identityMembers, attestations, connections, nicknames]) {
    const config = getTableConfig(table);
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`);
    const columns = config.columns
      .filter((column) => !column.name.startsWith('relationship_label_'))
      .map((column) => `"${column.name}" ${column.getSQLType()}`);
    await pg.exec(`CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(', ')})`);
  }
  // Apply the actual deploy migration twice, including its DB CHECK constraints.
  const migration = await readFile('migrations/archive/pre-kernel-baseline/0213_connection_relationship_labels.sql', 'utf8');
  await pg.exec(migration);
  await pg.exec(migration);
}, 30_000);

beforeEach(async () => {
  vi.clearAllMocks();
  await pg.exec('TRUNCATE auth.identities, auth.identity_members, auth.attestations, connections.connections, connections.nicknames');
  await database.insert(identities).values([
    { id: org, scope: 'business', publicKey: org },
    ...[owner, admin, client].map((id) => ({ id, scope: 'actor', subtype: 'human', publicKey: id })),
    { id: agent, scope: 'actor', subtype: 'agent', publicKey: agent },
  ]);
  await database.insert(identityMembers).values([
    { identityDid: org, memberDid: owner, role: 'owner' },
    { identityDid: org, memberDid: admin, role: 'admin' },
  ]);
  await database.insert(connections).values({ didA: org, didB: client, connectedAt: new Date() });
  vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex'));
  as();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await pg.close(); });

describe('private relationship labels (#2945)', () => {
  it.each([
    [owner, false], [admin, false], [owner, true], [admin, true],
  ])('sets, changes and clears as %s (act-as=%s)', async (actor, actingAs) => {
    as(actor, actingAs ? { actingAs: org } : {});
    for (const label of ['client', 'vendor', 'partner', 'other', null]) {
      expect(await patch({ relationshipLabel: label, ...(actingAs ? {} : { orgDid: org }) }))
        .toMatchObject({ status: 200, body: { did: client, relationshipLabel: label, attestationId: expect.any(String) } });
      expect((await connectionRows())[0].relationshipLabelA).toBe(label);
    }
    const audits = await auditRows();
    expect(audits.map((row) => row.payload)).toEqual([
      { orgDid: org, counterpartyDid: client, actorDid: actor, oldLabel: null, newLabel: 'client', disclosure_scope: 'parties' },
      ...[['client', 'vendor'], ['vendor', 'partner'], ['partner', 'other'], ['other', null]].map(([oldLabel, newLabel]) => ({
        orgDid: org, counterpartyDid: client, actorDid: actor, oldLabel, newLabel, disclosure_scope: 'parties',
      })),
    ]);
    for (const row of audits) {
      expect(row).toMatchObject({
        type: 'connection.relationship.label.changed', subjectDid: org, issuerDid: 'did:imajin:node',
        contextId: org, contextType: 'connection', disclosureScope: 'parties', attestationStatus: null,
      });
      const signed = canonicalize({
        subject_did: row.subjectDid, type: row.type, context_id: row.contextId,
        context_type: row.contextType, payload: row.payload, issued_at: row.issuedAt.getTime(),
      });
      expect(verify(null, Buffer.from(signed), keys.publicKey, Buffer.from(row.signature, 'hex'))).toBe(true);
      expect(verify(null, Buffer.from(`${signed}tampered`), keys.publicKey, Buffer.from(row.signature, 'hex'))).toBe(false);
    }
    expect(await database.select().from(identityMembers)).toHaveLength(2);
  });

  it.each([false, true])('returns only the caller side and updates only the org side (reversed=%s)', async (reversed) => {
    await database.delete(connections);
    await database.insert(connections).values({
      didA: reversed ? client : org, didB: reversed ? org : client, connectedAt: new Date(),
      relationshipLabelA: reversed ? 'partner' : null, relationshipLabelB: reversed ? null : 'partner',
    });
    expect((await listConnections(org))[0].relationshipLabel).toBeNull();
    expect((await listConnections(client))[0].relationshipLabel).toBe('partner');
    expect((await patch({ orgDid: org, relationshipLabel: 'client' })).status).toBe(200);
    const orgEntry = (await listConnections(org))[0];
    const clientEntry = (await listConnections(client))[0];
    expect(orgEntry).toMatchObject({ did: client, relationshipLabel: 'client', handle: 'counterparty', nickname: null });
    expect(clientEntry).toMatchObject({ did: org, relationshipLabel: 'partner' });
    expect(orgEntry).not.toHaveProperty('relationshipLabelA');
    expect(clientEntry).not.toHaveProperty('relationshipLabelB');
  });

  it('does not emit an event for unchanged labels', async () => {
    expect((await patch({ orgDid: org, relationshipLabel: null })).status).toBe(200);
    expect(await auditRows()).toHaveLength(0);
  });

  it.each(['member', 'maintainer', 'agent'])('rejects %s membership even with cached act-as authority', async (role) => {
    await database.update(identityMembers).set({ role }).where(eq(identityMembers.memberDid, owner));
    as(owner, { actingAs: org, actingAsRole: 'owner' });
    expect((await patch({ relationshipLabel: 'client' })).status).toBe(403);
    expect(await canManageRelationshipLabels(org, { id: owner })).toBe(false);
  });

  it.each([client, org, agent, 'did:imajin:stranger'])('rejects counterparty/noncontroller %s', async (id) => {
    as(id, { actingAs: org });
    expect((await patch({ orgDid: org, relationshipLabel: 'client' })).status).toBe(403);
    expect(await auditRows()).toHaveLength(0);
    expect((await connectionRows())[0].relationshipLabelA).toBeNull();
  });

  it('rejects removed, service-restricted, suspended and ambiguous controller authority', async () => {
    for (const change of [
      { removedAt: new Date() }, { allowedServices: ['pay'] },
    ]) {
      await database.update(identityMembers).set({ removedAt: null, allowedServices: null, ...change })
        .where(eq(identityMembers.memberDid, owner));
      expect((await patch({ orgDid: org, relationshipLabel: 'client' })).status).toBe(403);
    }
    await database.update(identityMembers).set({ allowedServices: ['connections'] });
    expect((await patch({ orgDid: org, relationshipLabel: 'client' })).status).toBe(200);
    await database.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, owner));
    expect((await patch({ orgDid: org, relationshipLabel: 'vendor' })).status).toBe(403);
    await database.update(identities).set({ suspendedAt: null });
    await database.insert(identityMembers).values({ identityDid: org, memberDid: owner, role: 'owner' });
    expect((await patch({ orgDid: org, relationshipLabel: 'vendor' })).status).toBe(403);
  });

  it.each(['community', 'actor', 'family'])('rejects nonbusiness org scope %s', async (scope) => {
    await database.update(identities).set({ scope }).where(eq(identities.id, org));
    expect((await patch({ orgDid: org, relationshipLabel: 'client' })).status).toBe(403);
  });

  it('rejects a suspended business and a direct agent even if incorrectly assigned owner membership', async () => {
    await database.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, org));
    expect((await patch({ orgDid: org, relationshipLabel: 'client' })).status).toBe(403);
    await database.update(identities).set({ suspendedAt: null });
    await database.insert(identityMembers).values({ identityDid: org, memberDid: agent, role: 'owner' });
    as(agent);
    expect((await patch({ orgDid: org, relationshipLabel: 'client' })).status).toBe(403);
  });

  it('denies delegated agents through shared policy; effective DID alone is not authority', async () => {
    as(agent, { actingFor: org });
    expect(await patch({ relationshipLabel: 'client' })).toMatchObject({
      status: 403, body: { code: 'AGENT_APPROVAL_REQUIRED', action: 'relationship-label' },
    });
    await expect(setRelationshipLabel(org, client, { id: agent, actingFor: owner }, 'client'))
      .rejects.toMatchObject({ status: 403 });
    expect(await auditRows()).toHaveLength(0);
  });

  it.each([
    {}, null, [], { relationshipLabel: 'customer' }, { relationshipLabel: '' },
    { relationshipLabel: 1 }, { relationshipLabel: false }, { relationshipLabel: {} },
    { relationshipLabel: 'client', orgDid: null }, { relationshipLabel: 'client', orgDid: '' },
    { relationshipLabel: 'client', orgDid: 5 }, { relationshipLabel: 'client', orgDid: 'not-a-did' },
  ])('rejects invalid payload %j', async (body) => {
    expect((await patch(body)).status).toBe(400);
    expect(await auditRows()).toHaveLength(0);
  });

  it('requires authentication, validates JSON and responds to CORS preflight', async () => {
    mocks.auth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });
    expect((await patch({ relationshipLabel: 'client' })).status).toBe(401);
    expect((await PATCH(new NextRequest('http://localhost', { method: 'PATCH', body: '{' }), params())).status).toBe(400);
    expect(OPTIONS(request(undefined, 'OPTIONS')).status).toBe(204);
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), { service: 'connections' });
  });

  it('rejects missing and disconnected connections, excluding inactive rows from reads', async () => {
    expect((await patch({ orgDid: org, relationshipLabel: 'client' }, 'did:imajin:missing')).status).toBe(404);
    await database.update(connections).set({ disconnectedAt: new Date() });
    expect((await patch({ orgDid: org, relationshipLabel: 'client' })).status).toBe(404);
    expect(await listConnections(org)).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  });

  it('rolls back label changes when signed event persistence fails', async () => {
    await pg.exec("ALTER TABLE auth.attestations ADD CONSTRAINT reject_label CHECK (type <> 'connection.relationship.label.changed')");
    try {
      expect((await patch({ orgDid: org, relationshipLabel: 'client' })).status).toBe(500);
      expect(mocks.logError).toHaveBeenCalledWith(
        { code: 'RELATIONSHIP_LABEL_UPDATE_FAILED' }, 'Relationship label update failed',
      );
      expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('newLabel');
      expect((await connectionRows())[0].relationshipLabelA).toBeNull();
      expect(await auditRows()).toHaveLength(0);
    } finally {
      await pg.exec('ALTER TABLE auth.attestations DROP CONSTRAINT reject_label');
    }
  });

  it('fails closed without signing material', async () => {
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    expect((await patch({ orgDid: org, relationshipLabel: 'client' })).status).toBe(500);
    expect((await connectionRows())[0].relationshipLabelA).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  it('serializes concurrent label changes with an unbroken old/new chain', async () => {
    await Promise.all([
      setRelationshipLabel(org, client, { id: owner }, 'client'),
      setRelationshipLabel(org, client, { id: admin }, 'vendor'),
    ]);
    const events = (await auditRows()).map((row) => row.payload as { oldLabel: string | null; newLabel: string });
    const first = events.find((event) => event.oldLabel === null)!;
    const second = events.find((event) => event.oldLabel === first.newLabel)!;
    expect(second).toBeDefined();
    expect((await connectionRows())[0].relationshipLabelA).toBe(second.newLabel);
  });

  it('enforces label constraints in SQL on both sides and accepts null', async () => {
    for (const column of ['relationship_label_a', 'relationship_label_b']) {
      await expect(pg.exec(`UPDATE connections.connections SET ${column} = 'customer'`)).rejects.toThrow();
      await pg.exec(`UPDATE connections.connections SET ${column} = NULL`);
    }
    expect(isRelationshipLabel(undefined)).toBe(false);
  });

  it('labelled counterparties get no roster/config access and never become members', async () => {
    expect((await patch({ orgDid: org, relationshipLabel: 'client' })).status).toBe(200);
    as(client);
    const groupParams = { params: Promise.resolve({ groupDid: org }) };
    expect((await ROSTER(request(undefined, 'GET'), groupParams)).status).toBe(403);
    expect((await CONFIG(request({ name: 'unauthorized' }), groupParams)).status).toBe(403);
    expect((await FOREST_CONFIG(request(undefined, 'GET'), groupParams)).status).toBe(403);
    expect((await UPDATE_FOREST_CONFIG(request({ theme: { private: false } }), groupParams)).status).toBe(403);
    expect(await database.select().from(identityMembers).where(eq(identityMembers.memberDid, client))).toEqual([]);
    expect((await database.select().from(identities).where(eq(identities.id, org)))[0].name).toBeNull();
  });
});

describe('GET relationship management capability', () => {
  async function get() {
    const response = await GET(request(undefined, 'GET'));
    return { status: response.status, body: await response.json() };
  }
  it.each([owner, admin])('allows live %s act-as and reports private labels', async (id) => {
    as(id, { actingAs: org });
    await patch({ relationshipLabel: 'client' });
    expect(await get()).toMatchObject({
      status: 200, body: { canManageRelationshipLabels: true, connections: [{ did: client, relationshipLabel: 'client' }] },
    });
  });
  it('does not grant personal identity, app or agent sessions management capability', async () => {
    expect((await get()).body.canManageRelationshipLabels).toBe(false);
    mocks.auth.mockClear();
    mocks.effective.mockResolvedValue({ ok: true, effectiveDid: org, via: 'app', composedBy: null });
    expect((await get()).body.canManageRelationshipLabels).toBe(false);
    expect(mocks.auth).not.toHaveBeenCalled();
    as(agent, { actingFor: org });
    expect((await get()).body.canManageRelationshipLabels).toBe(false);
  });
  it('rechecks live removed roles and service restrictions, not cached act-as claims', async () => {
    as(owner, { actingAs: org, actingAsRole: 'owner' });
    await database.update(identityMembers).set({ removedAt: new Date() }).where(eq(identityMembers.memberDid, owner));
    expect((await get()).body.canManageRelationshipLabels).toBe(false);
    await database.update(identityMembers).set({ removedAt: null, allowedServices: ['pay'] }).where(eq(identityMembers.memberDid, owner));
    expect((await get()).body.canManageRelationshipLabels).toBe(false);
  });
  it('fails capability closed without preventing reads on stale auth, DID mismatch or unavailable authority', async () => {
    as(owner, { actingAs: org });
    mocks.auth.mockResolvedValueOnce({ error: 'Auth unavailable', status: 503 });
    expect(await get()).toMatchObject({ status: 200, body: { canManageRelationshipLabels: false } });
    mocks.auth.mockResolvedValueOnce({ identity: { id: owner } });
    expect((await get()).body.canManageRelationshipLabels).toBe(false);
    mocks.auth.mockRejectedValueOnce(new Error('authority unavailable'));
    expect((await get()).body.canManageRelationshipLabels).toBe(false);
  });
  it('preserves read auth errors', async () => {
    mocks.effective.mockResolvedValueOnce({ ok: false, error: 'Unauthorized', status: 401 });
    expect(await get()).toMatchObject({ status: 401, body: { error: 'Unauthorized' } });
  });
});
