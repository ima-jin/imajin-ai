import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import * as auth from '@/src/db/schemas/auth';
import * as graph from '@/src/db/schemas/connections';
import * as notify from '@/src/db/schemas/notify';
import * as profile from '@/src/db/schemas/profile';

const mocks = vi.hoisted(() => ({
  db: null as unknown, begin: vi.fn(), publish: vi.fn(), send: vi.fn(),
  email: vi.fn(), effective: vi.fn(), push: vi.fn(),
}));
vi.mock('@imajin/db', () => ({ getClient: () => ({ begin: mocks.begin }) }));
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
vi.mock('@imajin/auth', () => ({
  resolveEffectiveDid: mocks.effective,
  requireAuth: async () => ({ identity: { id: 'did:imajin:operator' } }),
}));
vi.mock('@imajin/config', async (original) => ({
  ...await original<typeof import('@imajin/config')>(),
  rateLimit: () => ({ limited: false }),
}));
vi.mock('@imajin/bus', () => ({ publish: mocks.publish }));
vi.mock('@imajin/notify', () => ({ send: mocks.send, interest: vi.fn() }));
vi.mock('@/src/lib/mail/send', () => ({ sendKernelEmail: mocks.email }));
vi.mock('@/src/lib/notify/service-auth', () => ({
  authenticateNotifySender: async () => ({ response: null, internal: true, sender: {} }),
}));
vi.mock('@/src/lib/notify/payment-mail-sender', () => ({ resolvePaymentMailSender: async () => ({}) }));
vi.mock('@/src/lib/notify/template-store', async () => ({
  getTemplate: (await import('@/src/lib/notify/templates')).getTemplate,
}));
vi.mock('@/src/lib/notify/operator-approvals-service', () => ({ recordApprovalRequested: vi.fn() }));
vi.mock('@/src/lib/notify/web-push', () => ({ pushWebNotificationToOperator: vi.fn() }));
vi.mock('@/src/lib/notify/ws-push', () => ({
  buildNotificationFrame: (row: unknown) => row, pushNotificationToDid: mocks.push,
}));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({
  prepareMechanicalAttestation: async (input: { type: string; subjectDid: string; payload: unknown }) => ({
    id: `att_${crypto.randomUUID()}`, issuerDid: 'did:imajin:node',
    type: input.type, subjectDid: input.subjectDid, payload: input.payload, signature: 'fixture-signature',
  }),
}));

import { createDirectInvite, directInviteResponse, listIncomingDirectInvites, transitionDirectInvite } from '../direct-invites';
import { POST as sendNotification } from '@/app/notify/api/send/route';
import { notifyReactor } from '../../../../../../packages/bus/src/reactors/notify';

const pg = new PGlite();
const database = drizzle(pg);
const sender = 'did:imajin:studio';
const recipient = 'did:imajin:recipient';
const scope = 'connection:request-received';
const request = new NextRequest('http://localhost/connections/api/invites');
const tables = [
  auth.identities, auth.credentials, auth.attestations, graph.invitesInConnections,
  graph.connections, graph.podsInConnections, graph.podMembersInConnections,
  notify.notifications, notify.preferences, profile.profiles,
];

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });
beforeAll(async () => {
  mocks.db = database;
  await pg.exec('CREATE SCHEMA auth; CREATE SCHEMA connections; CREATE SCHEMA notify; CREATE SCHEMA profile;');
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
  mocks.effective.mockResolvedValue({ ok: true, effectiveDid: sender, via: 'session', composedBy: null });
  mocks.email.mockResolvedValue({ success: true });
  mocks.push.mockResolvedValue(false);
  // PGlite executes the actual credential/quota/channel SQL. Its single-session
  // adapter omits only the advisory lock; cross-worker ordering has a separate test.
  mocks.begin.mockImplementation(async (isolation, callback) => {
    expect(isolation).toBe('isolation level read committed');
    return pg.transaction((tx) => callback({
      unsafe: async (sql: string, values: unknown[]) => sql.includes('pg_advisory_xact_lock')
        ? [] : (await tx.query(sql, values)).rows,
    }));
  });
  mocks.send.mockImplementation(async (params) => {
    const response = await sendNotification(new NextRequest('http://localhost/notify/api/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
    }));
    expect(response.status).toBe(200);
  });
  mocks.publish.mockImplementation(async (type, event) => {
    // Delivery starts only after the invite and its one attestation committed.
    expect(await database.select().from(graph.invitesInConnections)).not.toHaveLength(0);
    await notifyReactor({ type, ...event }, { scope });
  });
  await database.insert(auth.identities).values([
    { id: sender, scope: 'business', publicKey: 'studio-key', tier: 'established', name: 'Example Studio', handle: 'studio' },
    { id: recipient, scope: 'actor', publicKey: 'recipient-key', tier: 'established', name: 'Recipient', handle: 'recipient', contactEmail: 'profile-only@example.com' },
    { id: 'did:imajin:operator', scope: 'actor', publicKey: 'operator-key', tier: 'established', name: 'Alice Example', handle: 'alice' },
  ]);
});

async function credential(verified = true) {
  await database.insert(auth.credentials).values({
    id: 'cred_email', did: recipient, type: 'email', value: 'recipient@example.com',
    verifiedAt: verified ? new Date() : null,
  });
}
async function create(target: Record<string, unknown> = { toDid: recipient }) {
  const response = await directInviteResponse(() => createDirectInvite(request, { ...target, note: '<b>Hello</b>' }));
  expect(response.status).toBe(201);
  const data = await response.json();
  expect(JSON.stringify(data)).not.toContain('@example.com');
  expect(data).not.toHaveProperty('emailResolved');
  return data;
}
async function transition(action: 'cancel' | 'decline' | 'accept') {
  const [invite] = await database.select().from(graph.invitesInConnections).where(eq(graph.invitesInConnections.status, 'pending'));
  mocks.effective.mockResolvedValue({ ok: true, effectiveDid: action === 'cancel' ? sender : recipient, via: 'app', composedBy: null });
  return directInviteResponse(() => transitionDirectInvite(request, invite, action));
}
async function rows() {
  const notifications = await database.select().from(notify.notifications);
  for (const notification of notifications) {
    expect(JSON.stringify(notification.data)).not.toContain('@example.com');
    expect(notification.scope).toBe(scope);
  }
  expect(JSON.stringify(mocks.publish.mock.calls)).not.toContain('@example.com');
  return notifications;
}

describe('direct request → generic notify → stored delivery (#3013)', () => {
  it.each([
    { target: { toDid: recipient }, personal: false },
    { target: { handle: '@recipient' }, personal: false },
    { target: { toDid: recipient }, personal: true },
    { target: { handle: '@recipient' }, personal: true },
  ])('delivers verified email and exactly one notification/attestation for %j', async ({ target, personal }) => {
    await credential();
    if (personal) mocks.effective.mockResolvedValue({
      ok: true, effectiveDid: 'did:imajin:operator', via: 'session', composedBy: null,
    });
    await create(target);
    expect(mocks.email).toHaveBeenCalledOnce();
    expect(mocks.email).toHaveBeenCalledWith(expect.objectContaining({ to: 'recipient@example.com' }));
    const html = mocks.email.mock.calls[0][0].html;
    expect(html).toContain('&lt;b&gt;Hello&lt;/b&gt;');
    if (personal) {
      expect(html).toContain('Alice Example (@alice) · did:imajin:operator');
      expect(html).not.toContain('Sent by');
    } else {
      expect(html).toContain('Sent by Alice Example on behalf of Example Studio');
    }
    expect(await rows()).toMatchObject([{ channelsSent: ['inapp', 'email'] }]);
    expect(await database.select().from(auth.attestations)).toMatchObject([{ type: 'connection.invited' }]);
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(JSON.stringify(await (await listIncomingDirectInvites(recipient)).json())).not.toContain('@example.com');
  });

  it.each(['absent', 'unverified', 'opted-out'] as const)('keeps in-app with no email for %s recipient', async (kind) => {
    if (kind !== 'absent') await credential(kind !== 'unverified');
    if (kind === 'opted-out') await database.insert(notify.preferences).values({
      id: 'pref_email', did: recipient, scope, email: false, inapp: true,
    });
    await create();
    expect(mocks.email).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([{ channelsSent: ['inapp'] }]);
    expect(mocks.push).toHaveBeenCalledOnce();
  });

  it.each(['provider unavailable', 'mail_not_configured', 'throw'])('preserves 201 and honest single in-app row on %s', async (failure) => {
    await credential();
    if (failure === 'throw') mocks.email.mockRejectedValueOnce(new Error('provider unavailable'));
    else mocks.email.mockResolvedValueOnce({ success: false, error: failure });
    await create();
    expect(await rows()).toMatchObject([{ channelsSent: ['inapp'] }]);
    expect(await database.select().from(auth.attestations)).toMatchObject([{ type: 'connection.invited' }]);
  });

  it('cancel/re-send inside 24h is in-app only; after the boundary it may email again', async () => {
    await credential();
    await create();
    expect((await transition('cancel')).status).toBe(200);
    mocks.effective.mockResolvedValue({ ok: true, effectiveDid: sender, via: 'app', composedBy: null });
    await create();
    expect(mocks.email).toHaveBeenCalledOnce();
    expect(await rows()).toMatchObject([{ channelsSent: ['inapp', 'email'] }, { channelsSent: ['inapp'] }]);
    expect((await transition('cancel')).status).toBe(200);
    await pg.exec("UPDATE notify.notifications SET created_at = clock_timestamp() - interval '24 hours 1 second'");
    mocks.effective.mockResolvedValue({ ok: true, effectiveDid: sender, via: 'app', composedBy: null });
    await create();
    expect(mocks.email).toHaveBeenCalledTimes(2);
    expect(await rows()).toHaveLength(3);
  });

  it.each(['cancel', 'decline', 'accept'] as const)('%s sends no subsequent email or notification', async (action) => {
    await credential();
    await create();
    expect((await transition(action)).status).toBe(action === 'accept' ? 201 : 200);
    expect(mocks.email).toHaveBeenCalledOnce();
    expect(await rows()).toHaveLength(1);
    expect(mocks.publish).toHaveBeenCalledOnce();
    const attestations = await database.select().from(auth.attestations);
    expect(attestations.filter((row) => row.type === 'connection.invited')).toHaveLength(1);
  });
});
