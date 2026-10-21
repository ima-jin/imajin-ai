import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { crypto, canonicalize } from '@imajin/auth';
import { NextRequest } from 'next/server';
import { requireAuth as realRequireAuth } from '../../../../../../packages/auth/src/require-auth';
import { resolveEffectiveDid as realResolveEffectiveDid } from '../../../../../../packages/auth/src/resolve-effective-did';
import { setVaultInternalApiKey } from '../../../../../../packages/auth/tests/support/internal-post-test-env';
import * as auth from '@/src/db/schemas/auth';
import * as graph from '@/src/db/schemas/connections';
import * as notify from '@/src/db/schemas/notify';
import * as profile from '@/src/db/schemas/profile';

const mocks = vi.hoisted(() => ({
  db: null as unknown, effective: vi.fn(), actor: vi.fn(), sign: vi.fn(), push: vi.fn(), rate: vi.fn(),
  publish: vi.fn(), error: vi.fn(),
}));
vi.mock('@imajin/logger', async (original) => ({
  ...await original<typeof import('@imajin/logger')>(),
  createLogger: () => ({ error: mocks.error, info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@imajin/config', async (original) => ({
  ...await original<typeof import('@imajin/config')>(), rateLimit: mocks.rate,
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/notify'),
  ...await import('@/src/db/schemas/connections'),
  ...await import('@/src/db/schemas/profile'),
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
vi.mock('@/src/lib/kernel/session', () => ({
  getSessionForDid: async (did: string) => ({ did, tier: 'established', handle: 'business' }),
  getSessionFromCookies: async () => ({ did: 'did:dfos:person', handle: 'Person' }),
}));
vi.mock('@imajin/bus', () => ({ publish: mocks.publish }));
vi.mock('@/src/lib/mail/send', () => ({ sendKernelEmail: vi.fn() }));
vi.mock('@/src/lib/auth/claimable-stub', () => ({
  resolveOrMintInviteTarget: vi.fn(), withNoDisclosure: (row: unknown) => row,
  isUnclaimedStub: () => false, tryActivateClaim: vi.fn(async () => undefined),
}));
vi.mock('@/src/lib/kernel/verification', () => ({
  checkPreliminaryEligibility: vi.fn(async () => undefined), checkHardEligibility: vi.fn(async () => undefined),
}));
vi.mock('@/src/lib/pay/payment-requests/claim', () => ({
  resolvePaymentRequestsOnRecipientClaim: vi.fn(async () => undefined),
}));

import { createDirectInvite, directInviteResponse, listIncomingDirectInvites, transitionDirectInvite } from '../direct-invites';
import * as inviteRoutes from '@/app/connections/api/invites/route';
import * as codeRoutes from '@/app/connections/api/invites/[code]/route';
import { POST as acceptRoute } from '@/app/connections/api/invites/[code]/accept/route';

const pg = new PGlite();
const signingKeys = crypto.generateKeypair();
const database = drizzle(pg);
const org = 'did:imajin:org';
const person = 'did:dfos:person';
const controller = 'did:imajin:owner';
const request = new Request('http://localhost/connections/api/invites');
const tables = [auth.identities, auth.attestations, graph.invitesInConnections, graph.connections, graph.podsInConnections,
  graph.podMembersInConnections, notify.notifications, notify.preferences, profile.profiles];

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });
beforeAll(async () => {
  mocks.db = database;
  await pg.exec('CREATE SCHEMA auth; CREATE SCHEMA connections; CREATE SCHEMA notify; CREATE SCHEMA profile;');
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setVaultInternalApiKey(undefined);
});
beforeEach(async () => {
  for (const table of [...tables].reverse()) {
    const config = getTableConfig(table);
    await pg.exec(`TRUNCATE "${config.schema}"."${config.name}"`);
  }
  vi.clearAllMocks();
  mocks.effective.mockResolvedValue({ ok: true, effectiveDid: org, via: 'session', composedBy: null });
  mocks.actor.mockResolvedValue({ identity: { id: 'did:imajin:owner', actingAs: org } });
  mocks.push.mockResolvedValue(false);
  mocks.publish.mockResolvedValue({});
  mocks.rate.mockReturnValue({ limited: false });
  vi.stubEnv('NEXT_PUBLIC_CONNECTIONS_URL', 'https://node.example.com/connections');
  const real = await vi.importActual<typeof import('@/src/lib/auth/emit-mechanical-attestation')>('@/src/lib/auth/emit-mechanical-attestation');
  mocks.sign.mockImplementation((input) => real.prepareMechanicalAttestation(input, undefined, {
    issuerDid: 'did:imajin:node', privateKey: signingKeys.privateKey,
  }));
  await database.insert(auth.identities).values([
    { id: org, scope: 'business', publicKey: 'org-key', tier: 'established', handle: 'business', name: 'Business' },
    { id: person, scope: 'actor', publicKey: 'person-key', tier: 'preliminary', handle: 'Person', name: 'Person' },
    { id: controller, scope: 'actor', publicKey: 'owner-key', tier: 'established', handle: 'owner', name: 'Owner' },
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
    expect(mocks.effective).toHaveBeenCalledWith(request, { scope: 'connections:write', service: 'connections' });
    expect(await response.json()).toMatchObject({ invite: { toDid: person, toHandle: 'Person', delivery: 'direct', maxUses: 1 } });
    expect(await database.select().from(graph.connections)).toHaveLength(0);
    expect(await database.select().from(graph.podMembersInConnections)).toHaveLength(0);
    // Delivery persistence belongs to notify.send, not the producer transaction.
    expect(await database.select().from(notify.notifications)).toHaveLength(0);
    const events = await database.select().from(auth.attestations);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({ type: 'connection.invited', payload: {
      fromDid: org, toDid: person, actorDid: 'did:imajin:owner', composedBy: null,
    } });
    expect(verifyEvent(event)).toBe(true);
    const invite = await storedInvite();
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith('connection.requested', {
      issuer: org, subject: person, scope: 'connections',
      payload: {
        inviteId: invite.id, code: invite.code, fromDid: org, fromHandle: 'business', fromName: 'Business',
        actorDid: controller, actorName: 'Owner', note: null,
        url: 'https://node.example.com/connections#incoming-requests',
      },
    });
  });
  it('publishes only after signed request commit and preserves the direct response allowlist', async () => {
    await database.update(auth.identities).set({ contactEmail: 'recipient@example.com' }).where(eq(auth.identities.id, person));
    const committed: unknown[] = [];
    mocks.publish.mockImplementationOnce(async () => {
      committed.push(await storedInvite(), await database.select().from(auth.attestations));
      return {};
    });
    const response = await create({ toDid: person, note: 'Let us connect', email: 'ignored@example.com' });
    expect(response.status).toBe(201);
    expect(committed[0]).toMatchObject({ delivery: 'direct', status: 'pending' });
    expect(committed[1]).toHaveLength(1);
    const json = await response.json();
    expect(Object.keys(json)).toEqual(['invite']);
    expect(Object.keys(json.invite).sort()).toEqual([
      'id', 'code', 'fromDid', 'fromHandle', 'toDid', 'note', 'delivery', 'status',
      'maxUses', 'usedCount', 'createdAt', 'acceptedAt', 'expiresAt', 'toHandle', 'toName',
    ].sort());
    expect(mocks.publish.mock.calls[0][1].payload.note).toBe('Let us connect');
    expect(JSON.stringify([json, mocks.publish.mock.calls])).not.toContain('@example.com');
    expect(mocks.push).not.toHaveBeenCalled();
  });
  it('keeps a committed request and its sole attestation when publishing fails', async () => {
    mocks.publish.mockRejectedValueOnce(new Error('bus unavailable'));
    expect((await create()).status).toBe(201);
    expect(await storedInvite()).toMatchObject({ status: 'pending', delivery: 'direct' });
    expect(await database.select().from(auth.attestations)).toHaveLength(1);
    expect(mocks.error).toHaveBeenCalledWith(
      { err: 'Error: bus unavailable' }, 'Direct request notification publish failed',
    );
    expect(await database.select().from(notify.notifications)).toHaveLength(0);
  });
  it('does not invent an act-as actor name for a personal request', async () => {
    asRecipient();
    expect((await create({ toDid: org })).status).toBe(201);
    expect(mocks.publish.mock.calls[0][1].payload).toMatchObject({
      fromDid: person, fromName: 'Person', actorDid: person, actorName: null,
    });
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
    expect(mocks.publish).toHaveBeenCalledTimes(1);
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
    expect(mocks.publish).toHaveBeenCalledTimes(1);
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
    expect(mocks.publish).not.toHaveBeenCalled();
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

function useRealAuth(services: string[] | null, did = controller, revokeOnRecheck = false) {
  let controllerChecks = 0;
  mocks.effective.mockImplementation(realResolveEffectiveDid);
  mocks.actor.mockImplementation(realRequireAuth);
  vi.stubEnv('AUTH_SERVICE_URL', 'https://auth.test');
  setVaultInternalApiKey('test-vault-key');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/session')) return Response.json({ did, scope: 'actor', tier: 'established' });
    if (url.includes('/controllers/')) {
      controllerChecks += 1;
      return Response.json({
        valid: true, role: 'maintainer',
        allowedServices: revokeOnRecheck && controllerChecks > 1 ? ['pay'] : services,
      });
    }
    throw new Error(`Unexpected auth URL: ${url}`);
  }));
}

function routeRequest(method: string, body?: object, overlay: 'header' | 'cookie' | 'none' = 'cookie', incoming = false) {
  return new NextRequest(`https://kernel.test/connections/api/invites${incoming ? '?direction=incoming' : ''}`, {
    method,
    headers: {
      cookie: `imajin_session=test${overlay === 'cookie' ? `; x-acting-as=${org}` : ''}`,
      ...(overlay === 'header' ? { 'x-acting-as': org } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const serviceRoutes = [
  { name: 'create', method: 'POST', status: 201, incoming: false },
  { name: 'outgoing list', method: 'GET', status: 200, incoming: false },
  { name: 'incoming list', method: 'GET', status: 200, incoming: true },
  { name: 'detail', method: 'GET', status: 200, incoming: false },
  { name: 'accept', method: 'POST', status: 201, incoming: true },
  { name: 'decline', method: 'PATCH', status: 200, incoming: true },
  { name: 'cancel', method: 'DELETE', status: 200, incoming: false },
] as const;

async function seedRequest(incoming: boolean) {
  if (incoming) asRecipient();
  expect((await create(incoming ? { toDid: org } : { toDid: person })).status).toBe(201);
}

async function runRoute(route: typeof serviceRoutes[number], overlay: 'header' | 'cookie') {
  const body = route.method === 'GET' ? undefined : { toDid: person, action: 'decline' };
  const req = routeRequest(route.method, body, overlay, route.incoming);
  if (route.name === 'create') return inviteRoutes.POST(req);
  if (route.name.endsWith('list')) return inviteRoutes.GET(req);
  const props = { params: Promise.resolve({ code: (await storedInvite()).code }) };
  if (route.name === 'detail') return codeRoutes.GET(req, props);
  if (route.name === 'accept') return acceptRoute(req, props);
  if (route.name === 'decline') return codeRoutes.PATCH(req, props);
  return codeRoutes.DELETE(req, props);
}

describe.each(['header', 'cookie'] as const)('direct request service gate (%s act-as)', (overlay) => {
  describe.each(serviceRoutes)('$name', (route) => {
    it.each([{ services: null }, { services: ['connections'] }])('allows unrestricted/listed maintainers ($services)', async ({ services }) => {
      if (route.name !== 'create') await seedRequest(route.incoming);
      vi.clearAllMocks();
      useRealAuth(services);
      const response = await runRoute(route, overlay);
      expect(response.status).toBe(route.status);
      if (route.name.endsWith('list')) {
        expect((await response.json()).invites).toEqual([
          expect.objectContaining({ fromDid: route.incoming ? person : org, toDid: route.incoming ? org : person }),
        ]);
      }
      if (route.name === 'create' || route.name === 'accept') {
        const [event] = await database.select().from(auth.attestations)
          .where(eq(auth.attestations.type, route.name === 'create' ? 'connection.invited' : 'connection.accepted'));
        expect(event.payload).toMatchObject({ actorDid: controller, effectiveDid: org });
        expect(verifyEvent(event)).toBe(true);
      }
      if (route.name === 'accept') expect(await storedInvite()).toMatchObject({ consumedBy: org, status: 'accepted' });
      if (route.name === 'decline') expect(await storedInvite()).toMatchObject({ status: 'declined' });
      if (route.name === 'cancel') expect(await storedInvite()).toMatchObject({ status: 'revoked' });
      if (['create', 'accept', 'decline', 'cancel'].includes(route.name)) {
        expect(mocks.actor).toHaveBeenCalledWith(expect.anything(), { service: 'connections' });
      }
    });

    it.each([{ services: ['pay'] }, { services: [] }])('refuses restricted maintainers ($services) without personal fallback or mutations', async ({ services }) => {
      if (route.name !== 'create') await seedRequest(route.incoming);
      const before = await Promise.all(tables.map((table) => database.select().from(table)));
      vi.clearAllMocks();
      useRealAuth(services);
      const response = await runRoute(route, overlay);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Not authorized to act as this group' });
      expect(await Promise.all(tables.map((table) => database.select().from(table)))).toEqual(before);
      expect(mocks.sign).not.toHaveBeenCalled();
      expect(mocks.push).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
    });
  });
});

it('preserves a service refusal from the real-actor recheck without falling back or creating state', async () => {
  useRealAuth(['connections'], controller, true);
  const response = await inviteRoutes.POST(routeRequest('POST', { toDid: person }));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'Not authorized to act as this group' });
  expect(await database.select().from(graph.invitesInConnections)).toEqual([]);
});

it('accepts a personal direct request only as its recipient, never via an org-to-person fallback', async () => {
  await create();
  useRealAuth(['connections'], person);
  const props = { params: Promise.resolve({ code: (await storedInvite()).code }) };
  expect((await acceptRoute(routeRequest('POST', {}), props)).status).toBe(403);
  expect(await storedInvite()).toMatchObject({ status: 'pending', usedCount: 0 });
  expect((await acceptRoute(routeRequest('POST', {}, 'none'), props)).status).toBe(201);
  expect(await storedInvite()).toMatchObject({ consumedBy: person, status: 'accepted' });
});

it('keeps legacy link acceptance personal even when an org with unlisted services is selected', async () => {
  await create();
  await database.update(graph.invitesInConnections).set({ delivery: 'link' });
  useRealAuth(['pay']);
  const props = { params: Promise.resolve({ code: (await storedInvite()).code }) };
  expect((await acceptRoute(routeRequest('POST', {}), props)).status).toBe(201);
  expect(await storedInvite()).toMatchObject({ consumedBy: person, status: 'accepted' });
});
