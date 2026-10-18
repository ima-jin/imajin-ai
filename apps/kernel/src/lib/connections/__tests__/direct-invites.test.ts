import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { crypto, canonicalize } from '@imajin/auth';
import * as auth from '@/src/db/schemas/auth';
import * as graph from '@/src/db/schemas/connections';
import * as notify from '@/src/db/schemas/notify';

const mocks = vi.hoisted(() => ({ db: null as unknown, effective: vi.fn(), actor: vi.fn(), sign: vi.fn(), push: vi.fn(), rate: vi.fn() }));
vi.mock('@imajin/config', async (original) => ({
  ...await original<typeof import('@imajin/config')>(), rateLimit: mocks.rate,
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/notify'),
  ...await import('@/src/db/schemas/connections'),
  invites: (await import('@/src/db/schemas/connections')).invitesInConnections,
  pods: (await import('@/src/db/schemas/connections')).podsInConnections,
  podMembers: (await import('@/src/db/schemas/connections')).podMembersInConnections,
  get db() { return mocks.db; },
}));
vi.mock('@imajin/auth', async (original) => ({
  ...await original<typeof import('@imajin/auth')>(), resolveEffectiveDid: mocks.effective, requireAuth: mocks.actor,
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({ prepareMechanicalAttestation: mocks.sign }));
vi.mock('@/src/lib/notify/ws-push', () => ({ buildNotificationFrame: (row: unknown) => row, pushNotificationToDid: mocks.push }));

import { createDirectInvite, directInviteResponse, listIncomingDirectInvites, transitionDirectInvite } from '../direct-invites';

const pg = new PGlite();
const signingKeys = crypto.generateKeypair();
const database = drizzle(pg);
const org = 'did:imajin:org';
const person = 'did:dfos:person';
const request = new Request('http://localhost/connections/api/invites');
const tables = [auth.identities, auth.attestations, graph.invitesInConnections, graph.connections, graph.podsInConnections,
  graph.podMembersInConnections, notify.notifications, notify.preferences];

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });
beforeAll(async () => {
  mocks.db = database;
  await pg.exec('CREATE SCHEMA auth; CREATE SCHEMA connections; CREATE SCHEMA notify;');
  // Mirror current columns, including defaults, without depending on unrelated migrations.
  for (const table of tables) {
    const config = getTableConfig(table);
    const columns = config.columns.map((column) => {
      const type = column.getSQLType();
      let fallback = '';
      if (column.hasDefault) {
        if (type.includes('timestamp')) fallback = ' DEFAULT now()';
        else if (type === 'integer') fallback = ' DEFAULT 0';
        else if (type === 'boolean') fallback = ' DEFAULT false';
        else if (type === 'jsonb') fallback = " DEFAULT '{}'";
        else if (type.endsWith('[]')) fallback = " DEFAULT '{}'";
        else fallback = " DEFAULT ''";
      }
      return `"${column.name}" ${type}${fallback}`;
    });
    const pk = config.primaryKeys[0]?.columns.map((column) => `"${column.name}"`);
    if (pk) columns.push(`PRIMARY KEY (${pk.join(',')})`);
    await pg.exec(`CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(',')});`);
  }
});
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  for (const table of [...tables].reverse()) {
    const config = getTableConfig(table);
    await pg.exec(`TRUNCATE "${config.schema}"."${config.name}"`);
  }
  vi.clearAllMocks();
  mocks.effective.mockResolvedValue({ ok: true, effectiveDid: org, via: 'session', composedBy: null });
  mocks.actor.mockResolvedValue({ identity: { id: 'did:imajin:owner', actingAs: org } });
  mocks.push.mockResolvedValue(false);
  mocks.rate.mockReturnValue({ limited: false });
  const real = await vi.importActual<typeof import('@/src/lib/auth/emit-mechanical-attestation')>('@/src/lib/auth/emit-mechanical-attestation');
  mocks.sign.mockImplementation((input) => real.prepareMechanicalAttestation(input, undefined, {
    issuerDid: 'did:imajin:node', privateKey: signingKeys.privateKey,
  }));
  await database.insert(auth.identities).values([
    { id: org, scope: 'business', publicKey: 'org-key', tier: 'established', handle: 'business', name: 'Business' },
    { id: person, scope: 'actor', publicKey: 'person-key', tier: 'preliminary', handle: 'Person', name: 'Person' },
  ]);
});

async function create(body: Record<string, unknown> = { toDid: person }) {
  return directInviteResponse(() => createDirectInvite(request, body));
}
async function storedInvite() {
  return (await database.select().from(graph.invitesInConnections))[0];
}
function verifyEvent(event: typeof auth.attestations.$inferSelect) {
  return crypto.verifySync(event.signature, canonicalize({
    subject_did: event.subjectDid, type: event.type, context_id: event.contextId,
    context_type: event.contextType, payload: event.payload, issued_at: event.issuedAt.getTime(),
  }), signingKeys.publicKey);
}
function asRecipient() {
  mocks.effective.mockResolvedValue({ ok: true, effectiveDid: person, via: 'session', composedBy: null });
  mocks.actor.mockResolvedValue({ identity: { id: person } });
}
async function transition(action: 'accept' | 'decline' | 'cancel') {
  const invite = await storedInvite();
  return directInviteResponse(() => transitionDirectInvite(request, invite, action));
}

describe('direct requests persisted lifecycle', () => {
  it.each([{ toDid: person }, { handle: '@pErSoN' }])('creates exact public target %j with signed org/actor attribution and no selectable connection', async (body) => {
    const response = await create(body);
    expect(response.status).toBe(201);
    expect(mocks.effective).toHaveBeenCalledWith(request, { scope: 'connections:write' });
    expect(await response.json()).toMatchObject({ invite: { toDid: person, toHandle: 'Person', delivery: 'direct', maxUses: 1 } });
    expect(await database.select().from(graph.connections)).toHaveLength(0);
    expect(await database.select().from(graph.podMembersInConnections)).toHaveLength(0);
    expect(await database.select().from(notify.notifications)).toHaveLength(1);
    const [event] = await database.select().from(auth.attestations);
    expect(event).toMatchObject({ type: 'connection.invited', payload: {
      fromDid: org, toDid: person, actorDid: 'did:imajin:owner', composedBy: null,
    } });
    expect(verifyEvent(event)).toBe(true);
  });
  it('accepts only named authenticated recipient and commits pod, pair, status and signed evidence together', async () => {
    await create();
    expect((await transition('accept')).status).toBe(403);
    asRecipient();
    const incoming = await (await listIncomingDirectInvites(person)).json();
    expect(incoming.invites[0]).toMatchObject({ fromDid: org, fromName: 'Business', toHandle: 'Person' });
    expect(incoming.invites[0]).not.toHaveProperty('toEmail');
    expect((await transition('accept')).status).toBe(201);
    expect(await database.select().from(graph.connections)).toHaveLength(1);
    expect(await database.select().from(graph.podMembersInConnections)).toHaveLength(2);
    expect(await storedInvite()).toMatchObject({ status: 'accepted', usedCount: 1 });
    expect((await database.select().from(auth.attestations)).map((row) => row.type)).toEqual(['connection.invited', 'connection.accepted']);
    for (const event of await database.select().from(auth.attestations)) expect(verifyEvent(event)).toBe(true);
    expect((await transition('accept')).status).toBe(410);
    expect(await (await listIncomingDirectInvites(person)).json()).toEqual({ invites: [] });
  });
  it.each(['decline', 'cancel'] as const)('%s is role-bound and terminal without a connection', async (action) => {
    await create();
    if (action === 'cancel') asRecipient();
    expect((await transition(action)).status).toBe(403);
    if (action === 'decline') asRecipient();
    else mocks.effective.mockResolvedValue({ ok: true, effectiveDid: org, via: 'app', composedBy: null });
    expect((await transition(action)).status).toBe(200);
    asRecipient();
    expect((await transition('accept')).status).toBe(410);
    expect(await database.select().from(graph.connections)).toHaveLength(0);
  });
  it('rejects duplicate and reverse pending requests', async () => {
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(409);
    asRecipient();
    expect((await create({ toDid: org })).status).toBe(409);
  });
  it('rejects active pairs, self, missing, soft and suspended targets', async () => {
    expect((await create({ toDid: org })).status).toBe(400);
    expect((await create({ toDid: 'did:web:missing' })).status).toBe(404);
    await database.update(auth.identities).set({ tier: 'soft' }).where(eq(auth.identities.id, person));
    expect((await create()).status).toBe(404);
    await database.update(auth.identities).set({ tier: 'preliminary', suspendedAt: new Date() }).where(eq(auth.identities.id, person));
    expect((await create()).status).toBe(404);
    await database.update(auth.identities).set({ suspendedAt: null }).where(eq(auth.identities.id, person));
    await create(); asRecipient(); await transition('accept');
    expect((await create({ toDid: org })).status).toBe(409);
  });
  it('rolls back request and acceptance state when signing fails', async () => {
    mocks.sign.mockRejectedValueOnce(new Error('signing unavailable'));
    expect((await create()).status).toBe(503);
    expect(await database.select().from(graph.invitesInConnections)).toHaveLength(0);
    expect(await database.select().from(notify.notifications)).toHaveLength(0);
    await create(); asRecipient();
    mocks.sign.mockRejectedValueOnce(new Error('signing unavailable'));
    expect((await transition('accept')).status).toBe(503);
    expect(await storedInvite()).toMatchObject({ status: 'pending', usedCount: 0 });
    expect(await database.select().from(graph.connections)).toHaveLength(0);
    expect(await database.select().from(graph.podsInConnections)).toHaveLength(0);
  });
  it('requires authentication even with a leaked direct code', async () => {
    await create();
    mocks.effective.mockResolvedValue({ ok: false, error: 'Unauthorized', status: 401 });
    expect((await transition('accept')).status).toBe(401);
    expect(await database.select().from(graph.connections)).toHaveLength(0);
  });
  it.each([{}, { toDid: person, handle: '@Person' }, { toDid: person, delivery: 'email' }, { handle: '' }, { toDid: 'not-a-did' }])('rejects ambiguous or invalid direct target input %j', async (body) => {
    expect((await create(body)).status).toBe(400);
    expect(await database.select().from(graph.invitesInConnections)).toHaveLength(0);
  });
  it('rate-limits the real actor and effective DID before creating state', async () => {
    mocks.rate.mockReturnValueOnce({ limited: false }).mockReturnValueOnce({ limited: true, retryAfter: 42 });
    const response = await create();
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(mocks.rate.mock.calls.map((call) => call[0])).toEqual([
      'connections:direct:actor:did:imajin:owner', 'connections:direct:effective:did:imajin:org',
    ]);
    expect(await database.select().from(graph.invitesInConnections)).toHaveLength(0);
  });
  it('permits sender cancellation after the recipient becomes suspended', async () => {
    await create();
    await database.update(auth.identities).set({ suspendedAt: new Date() }).where(eq(auth.identities.id, person));
    expect((await transition('cancel')).status).toBe(200);
    expect(await storedInvite()).toMatchObject({ status: 'revoked' });
  });
  it('serializes simultaneous duplicate creation and double acceptance', async () => {
    // PGlite queues transactions on one connection; row-lock contention across
    // real PostgreSQL connections is additionally guaranteed by ordered FOR UPDATE.
    expect((await Promise.all([create(), create()])).map((r) => r.status).sort()).toEqual([201, 409]);
    asRecipient();
    expect((await Promise.all([transition('accept'), transition('accept')])).map((r) => r.status).sort()).toEqual([201, 410]);
    expect(await database.select().from(graph.podsInConnections)).toHaveLength(1);
  });
});
