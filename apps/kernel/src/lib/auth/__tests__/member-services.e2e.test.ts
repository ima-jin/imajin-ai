import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { NextRequest } from 'next/server';
import { canonicalize } from '@imajin/auth';
import * as authSchema from '@/src/db/schemas/auth';
import * as paySchema from '@/src/db/schemas/pay';
import * as connectionSchema from '@/src/db/schemas/connections';
import { setVaultInternalApiKey } from '../../../../../../packages/auth/tests/support/internal-post-test-env';

const mocks = vi.hoisted(() => ({ db: null as unknown, publish: vi.fn(async () => undefined) }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/pay'),
  ...await import('@/src/db/schemas/profile'),
  ...await import('@/src/db/schemas/connections'),
  get db() { return mocks.db; },
}));
// Only external boundaries are substituted. Authentication, membership reads,
// scope enforcement, payment writes and signed evidence all run real code.
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@/src/lib/vault/internal-secret', () => ({ getInternalSecret: async () => 'fixture-internal-key' }));
vi.mock('@/src/lib/kernel/lookup', () => ({ lookupIdentity: async () => null }));
vi.mock('@/src/lib/connections/payment-request-invite', () => ({ createPaymentRequestInvite: vi.fn() }));
vi.mock('@imajin/bus', () => ({ publish: mocks.publish, registerReactor: vi.fn() }));
vi.mock('@/src/lib/kernel/app-nav', () => ({ resolveAppDirectoryForIdentity: async () => [] }));

import { POST as addMember } from '@/app/auth/api/groups/[groupDid]/controllers/route';
import { GET as readMember, PATCH as editMember } from '@/app/auth/api/groups/[groupDid]/controllers/[controllerDid]/route';
import { POST as createPayment } from '@/app/pay/api/payment-requests/route';
import { GET as listConnections } from '@/app/connections/api/connections/route';

const ORG = 'did:imajin:org';
const OWNER = 'did:imajin:owner';
const MAINTAINER = 'did:imajin:maintainer';
const CUSTOMER = 'did:imajin:customer';
const PERSONAL_CONTACT = 'did:imajin:personal-contact';
const pg = new PGlite();
const schema = { ...authSchema, ...paySchema, ...connectionSchema };
const database = drizzle(pg, { schema });
const keys = generateKeyPairSync('ed25519');
const memberParams = { params: Promise.resolve({ groupDid: ORG, controllerDid: MAINTAINER }) };

function request(path: string, actor: string, body?: unknown, overlay?: 'header' | 'cookie') {
  return new NextRequest(`http://kernel.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: `imajin_session=${actor}${overlay === 'cookie' ? `; x-acting-as=${ORG}` : ''}`,
      ...(overlay === 'header' ? { 'x-acting-as': ORG } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function edit(body: unknown) {
  const req = request('/auth/api/groups/org/controllers/maintainer', OWNER, body);
  return editMember(new NextRequest(req, { method: 'PATCH' }), memberParams);
}

async function signedRecords() {
  const records = await database.select().from(authSchema.attestations);
  for (const record of records) {
    const signed = canonicalize({
      subject_did: record.subjectDid, type: record.type, context_id: record.contextId,
      context_type: record.contextType, payload: record.payload, issued_at: record.issuedAt.getTime(),
    });
    expect(verify(null, Buffer.from(signed), keys.publicKey, Buffer.from(record.signature, 'hex'))).toBe(true);
  }
  return records;
}

beforeAll(async () => {
  mocks.db = database;
  await pg.exec('CREATE SCHEMA auth; CREATE SCHEMA pay; CREATE SCHEMA connections;');
  for (const table of [
    authSchema.identities, authSchema.identityMembers, authSchema.attestations,
    paySchema.paymentRequests, connectionSchema.connections, connectionSchema.nicknames,
  ]) {
    const config = getTableConfig(table);
    const columns = config.columns.map((column) => `"${column.name}" ${column.getSQLType()}`);
    await pg.exec(`CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(', ')});`);
  }
});

beforeEach(async () => {
  vi.clearAllMocks();
  await pg.exec('TRUNCATE auth.identities, auth.identity_members, auth.attestations, pay.payment_request, connections.connections, connections.nicknames;');
  await database.insert(authSchema.identities).values([
    { id: ORG, scope: 'business', publicKey: ORG },
    { id: OWNER, scope: 'actor', subtype: 'human', publicKey: OWNER },
    { id: MAINTAINER, scope: 'actor', subtype: 'human', publicKey: MAINTAINER },
  ]);
  await database.insert(authSchema.identityMembers).values({ identityDid: ORG, memberDid: OWNER, role: 'owner' });
  for (const [didA, didB] of [[ORG, CUSTOMER], [MAINTAINER, PERSONAL_CONTACT]]) {
    const [first, second] = [didA, didB].sort((a, b) => a.localeCompare(b));
    await database.insert(connectionSchema.connections).values({
      id: `${first}-${second}`, didA: first, didB: second, connectedAt: new Date(),
    });
  }
  vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex'));
  vi.stubEnv('AUTH_SERVICE_URL', 'http://auth.test');
  setVaultInternalApiKey('fixture-internal-key');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/session')) {
      const cookie = new Headers(init?.headers).get('cookie') ?? '';
      const actor = cookie.split('=')[1];
      return Response.json({ did: actor, scope: 'actor', subtype: 'human' });
    }
    if (url.includes('/controllers/')) {
      return readMember(new NextRequest(url, init), memberParams);
    }
    throw new Error(`Unexpected external request: ${url}`);
  }));
});

afterEach(() => {
  setVaultInternalApiKey(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => { await pg.close(); });

describe('Members service scope → real act-as enforcement (#2956)', () => {
  it.each(['header', 'cookie'] as const)('creates org payments, refuses connections without personal fallback, restores All services (%s)', async (overlay) => {
    const added = await addMember(request('/auth/api/groups/org/controllers', OWNER, {
      did: MAINTAINER, role: 'maintainer', allowedServices: null,
    }), { params: Promise.resolve({ groupDid: ORG }) });
    expect(added.status).toBe(201);
    expect((await edit({ allowedServices: ['pay'] })).status).toBe(200);
    const payment = await createPayment(request('/pay/api/payment-requests', MAINTAINER, {
      issuer_did: ORG, recipient_did: CUSTOMER,
      line_items: [{ name: 'Org work', amount: 5000, quantity: 1 }], currency: 'CAD',
    }, overlay));
    expect(payment.status).toBe(201);
    expect(await payment.json()).toMatchObject({ issuerDid: ORG, recipientDid: CUSTOMER, totalAmount: 5000 });
    const stored = await database.select().from(paySchema.paymentRequests);
    expect(stored).toHaveLength(1);
    expect(stored[0].issuerDid).toBe(ORG);

    const refused = await listConnections(request('/connections/api/connections', MAINTAINER, undefined, overlay));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Not authorized to act as this group' });
    // The personal identity has data and is usable without act-as; it must
    // not become a fallback when the selected org refuses this service.
    const personal = await listConnections(request('/connections/api/connections', MAINTAINER));
    expect((await personal.json()).connections).toEqual([expect.objectContaining({ did: PERSONAL_CONTACT })]);
    expect((await edit({ allowedServices: [] })).status).toBe(400);
    expect((await listConnections(request('/connections/api/connections', MAINTAINER, undefined, overlay))).status).toBe(403);

    expect((await edit({ allowedServices: null })).status).toBe(200);
    const restored = await listConnections(request('/connections/api/connections', MAINTAINER, undefined, overlay));
    expect(restored.status).toBe(200);
    expect((await restored.json()).connections).toEqual([expect.objectContaining({ did: CUSTOMER })]);
    const records = await signedRecords();
    const changes = records.filter((record) => record.type === 'group.member.role.changed');
    expect(changes.map((record) => record.payload)).toEqual([
      expect.objectContaining({ by: OWNER, oldAllowedServices: null, allowedServices: ['pay'] }),
      expect.objectContaining({ by: OWNER, oldAllowedServices: ['pay'], allowedServices: null }),
    ]);
    expect(records).toContainEqual(expect.objectContaining({ type: 'payment_request.issued', issuerDid: ORG }));
  });
});
