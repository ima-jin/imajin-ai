import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { canonicalize, type Identity } from '@imajin/auth';
import * as authSchema from '@/src/db/schemas/auth';
import { nodeConfig } from '@/src/db/schemas/registry';
import { identityAliases } from '@/src/db/schemas/identity-aliases';
import { profiles } from '@/src/db/schemas/profile';

const mocks = vi.hoisted(() => ({ db: null as unknown, auth: vi.fn() }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/registry'),
  ...await import('@/src/db/schemas/identity-aliases'),
  ...await import('@/src/db/schemas/profile'),
  get db() { return mocks.db; },
}));
vi.mock('@imajin/auth', async (original) => ({
  ...await original<typeof import('@imajin/auth')>(), requireAuth: mocks.auth,
  requireAppAuth: vi.fn().mockResolvedValue({ error: 'Not an app token', status: 401 }),
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/auth/require-internal-api-key', () => ({ requireInternalApiKey: vi.fn() }));

import { GET, POST, DELETE, OPTIONS } from '@/app/auth/api/groups/[groupDid]/transfer-owner/route';
import { POST as ACCEPT } from '@/app/auth/api/groups/[groupDid]/transfer-owner/accept/route';
import { DELETE as REMOVE } from '@/app/auth/api/groups/[groupDid]/controllers/[controllerDid]/route';
import { POST as ADD } from '@/app/auth/api/groups/[groupDid]/controllers/route';
import { GET as GROUP_GET } from '@/app/auth/api/groups/[groupDid]/route';
import { DELETE as REVOKE_AGENT } from '@/app/auth/api/agents/[did]/route';
import { POST as REGISTRY_IDENTITY } from '@/app/registry/api/identity/route';
import { ownershipTransfer } from '../ownership-transfer';
import { ownershipPolicies, OWNERSHIP_POLICY_KEY, PENDING_OWNER_TRANSFER_KEY, readPendingTransfer } from '../ownership-policy';

const pg = new PGlite();
const schema = { ...authSchema, nodeConfig, identityAliases, profiles };
const database = drizzle(pg, { schema });
const keys = generateKeyPairSync('ed25519');
const groupDid = 'did:imajin:group';
const owner = 'did:imajin:owner';
const recipient = 'did:imajin:recipient';
const stranger = 'did:imajin:stranger';
const agent = 'did:imajin:agent';
const params = () => ({ params: Promise.resolve({ groupDid }) });
type Handler = typeof POST;

function as(did: string, extra: Partial<Identity> = {}) {
  mocks.auth.mockResolvedValue({ identity: { id: did, scope: 'actor', ...extra } });
}

async function call(handler: Handler, body?: unknown, method = 'POST') {
  const request = new NextRequest(`http://localhost/auth/api/groups/${groupDid}/transfer-owner`, {
    method, headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await handler(request, params());
  return { response, body: await response.json() };
}

async function propose(to = recipient) {
  as(owner);
  const result = await call(POST, { newOwnerDid: to });
  expect(result.response.status).toBe(201);
  return result.body.pendingTransfer.id as string;
}

async function rows() {
  return database.select().from(authSchema.identityMembers);
}

beforeAll(async () => {
  mocks.db = database;
  await pg.exec('CREATE SCHEMA auth; CREATE SCHEMA registry;');
  // Use the production Drizzle column definitions, not a fake query builder.
  for (const table of [authSchema.identities, authSchema.identityMembers, authSchema.attestations, nodeConfig, identityAliases, profiles]) {
    const config = getTableConfig(table);
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS "${config.schema}";`);
    const columns = config.columns.map((column) => `"${column.name}" ${column.getSQLType()}`);
    await pg.exec(`CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(', ')});`);
  }
});
beforeEach(async () => {
  await pg.exec('TRUNCATE auth.identities, auth.identity_members, auth.attestations, registry.node_config, kernel.identity_aliases, profile.profiles');
  await database.insert(authSchema.identities).values([
    { id: groupDid, scope: 'business', publicKey: groupDid, name: 'Test business', metadata: { unrelated: { kept: true } } },
    ...[owner, recipient, stranger].map((id) => ({ id, scope: 'actor', subtype: 'human', publicKey: id })),
    { id: agent, scope: 'actor', subtype: 'agent', publicKey: agent },
  ]);
  await database.insert(profiles).values({ did: groupDid, claimedBy: owner });
  await database.insert(authSchema.identityMembers).values([
    { identityDid: groupDid, memberDid: owner, role: 'owner' },
    { identityDid: groupDid, memberDid: recipient, role: 'member' },
  ]);
  vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex'));
  as(owner);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await pg.close(); });

describe('ownership transfer real database lifecycle (#2892)', () => {
  it('changes owner only on acceptance, demotes old owner, preserves metadata and stores a verifiable signed record', async () => {
    const transferId = await propose();
    expect((await rows()).find((row) => row.memberDid === owner)?.role).toBe('owner');
    as(recipient);
    expect((await call(GET, undefined, 'GET')).body).toMatchObject({ canAccept: true, viewerRole: 'member' });
    const result = await call(ACCEPT, { transferId });
    expect(result.body).toMatchObject({ ok: true, ownerDid: recipient, attestationId: expect.any(String) });
    expect(await rows()).toEqual(expect.arrayContaining([
      expect.objectContaining({ memberDid: owner, role: 'admin' }),
      expect.objectContaining({ memberDid: recipient, role: 'owner', allowedServices: null }),
    ]));
    const [group] = await database.select().from(authSchema.identities).where(eq(authSchema.identities.id, groupDid));
    expect(group.metadata).toEqual({ unrelated: { kept: true } });
    const [attestation] = await database.select().from(authSchema.attestations);
    expect(await database.select({ claimedBy: profiles.claimedBy }).from(profiles)).toEqual([{ claimedBy: recipient }]);
    expect(attestation).toMatchObject({
      id: result.body.attestationId, type: 'identity.owner.transferred', attestationStatus: null,
      issuerDid: 'did:imajin:node', subjectDid: groupDid,
      payload: { from: owner, to: recipient, by: owner, policy: 'owner-only', acceptedBy: recipient, transferId },
    });
    const signed = canonicalize({
      subject_did: attestation.subjectDid, type: attestation.type, context_id: attestation.contextId,
      context_type: attestation.contextType, payload: attestation.payload, issued_at: attestation.issuedAt.getTime(),
    });
    expect(verify(null, Buffer.from(signed), keys.publicKey, Buffer.from(attestation.signature, 'hex'))).toBe(true);
    expect(verify(null, Buffer.from(`${signed}tampered`), keys.publicKey, Buffer.from(attestation.signature, 'hex'))).toBe(false);
    const details = await GROUP_GET(new NextRequest('http://localhost/auth/api/groups/group'), params());
    expect(await details.json()).toMatchObject({ createdBy: recipient });
    as(owner);
    expect((await call(GET, undefined, 'GET')).body).toMatchObject({ viewerRole: 'admin', canTransfer: false, ownerDid: recipient });
    const leave = await REMOVE(new NextRequest('http://localhost', {
      method: 'DELETE', headers: { cookie: `x-acting-as=${groupDid}` },
    }), {
      params: Promise.resolve({ groupDid, controllerDid: owner }),
    });
    expect(leave.status).toBe(200);
    expect(leave.headers.get('set-cookie')).toContain('x-acting-as=;');
    expect(leave.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await rows()).find((row) => row.memberDid === owner)?.removedAt).toBeInstanceOf(Date);
  });

  it('offers a DID-bound invite to a nonmember; GET does not join, acceptance joins atomically', async () => {
    const transferId = await propose(stranger);
    as(stranger);
    expect((await call(GET, undefined, 'GET')).body).toMatchObject({
      viewerRole: null, canAccept: true, acceptanceUrl: `/auth/groups/${encodeURIComponent(groupDid)}/ownership`,
    });
    expect(await rows()).toHaveLength(2);
    expect((await call(ACCEPT, { transferId })).response.status).toBe(200);
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: stranger, role: 'owner', addedVia: 'invite' }));
  });

  it('reactivates a removed recipient and clears their service restrictions', async () => {
    await database.update(authSchema.identityMembers).set({ removedAt: new Date(), allowedServices: ['media'] })
      .where(eq(authSchema.identityMembers.memberDid, recipient));
    const transferId = await propose();
    as(recipient);
    expect((await call(ACCEPT, { transferId })).response.status).toBe(200);
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: recipient, role: 'owner', removedAt: null, allowedServices: null }));
  });

  it('cancels only the matching proposal, rejects stale ids, and requires a fresh id after cancellation', async () => {
    const transferId = await propose();
    expect((await call(DELETE, { transferId: 'stale' }, 'DELETE')).response.status).toBe(409);
    expect((await call(DELETE, { transferId }, 'DELETE')).body).toMatchObject({ pendingTransfer: null });
    as(recipient);
    expect((await call(ACCEPT, { transferId })).response.status).not.toBe(200);
    const freshId = await propose();
    expect(freshId).not.toBe(transferId);
    as(recipient);
    expect((await call(ACCEPT, { transferId })).response.status).toBe(409);
    expect((await call(ACCEPT, { transferId: freshId })).response.status).toBe(200);
    expect((await call(ACCEPT, { transferId: freshId })).response.status).not.toBe(200);
    expect(await database.select().from(authSchema.attestations)).toHaveLength(1);
  });

  it('serializes duplicate proposals, concurrent accept/replay and cancel/accept races', async () => {
    const proposals = await Promise.all([call(POST, { newOwnerDid: recipient }), call(POST, { newOwnerDid: stranger })]);
    expect(proposals.map((result) => result.response.status).sort((a, b) => a - b)).toEqual([201, 409]);
    const pending = proposals.find((result) => result.response.status === 201)!.body.pendingTransfer;
    const outcomes = await Promise.allSettled([
      ownershipTransfer(groupDid, { id: pending.to }, 'accept', { transferId: pending.id }),
      ownershipTransfer(groupDid, { id: owner }, 'cancel', { transferId: pending.id }),
      ownershipTransfer(groupDid, { id: pending.to }, 'accept', { transferId: pending.id }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await rows()).filter((row) => row.role === 'owner' && !row.removedAt)).toHaveLength(1);
    expect(await database.select().from(authSchema.attestations)).toHaveLength(1);
  });

  it('rolls back role mutation, invite join and pending consumption when attestation insert fails', async () => {
    const transferId = await propose(stranger);
    await pg.exec(`ALTER TABLE auth.attestations ADD CONSTRAINT reject_transfer CHECK (type <> 'identity.owner.transferred')`);
    try {
      as(stranger);
      expect((await call(ACCEPT, { transferId })).response.status).toBe(500);
      expect(await rows()).not.toContainEqual(expect.objectContaining({ memberDid: stranger }));
      expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: owner, role: 'owner' }));
      as(owner);
      expect((await call(GET, undefined, 'GET')).body.pendingTransfer.id).toBe(transferId);
    } finally {
      await pg.exec('ALTER TABLE auth.attestations DROP CONSTRAINT reject_transfer');
    }
  });

  it('fails closed without signing material, before any owner roles change', async () => {
    const transferId = await propose();
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    as(recipient);
    expect((await call(ACCEPT, { transferId })).response.status).toBe(500);
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: owner, role: 'owner' }));
    expect(await database.select().from(authSchema.attestations)).toHaveLength(0);
  });
});

describe('ownership authorization and API errors', () => {
  it('allows the real human owner in their selected group session and the real recipient to accept', async () => {
    as(owner, { actingAs: groupDid });
    const proposal = await call(POST, { newOwnerDid: recipient });
    expect(proposal.response.status).toBe(201);
    as(recipient, { actingAs: groupDid });
    expect((await call(ACCEPT, { transferId: proposal.body.pendingTransfer.id })).response.status).toBe(200);
  });

  it('rejects reserved metadata injection and preserves the proposal during concurrent generic metadata edits', async () => {
    await database.insert(identityAliases).values({ namespace: 'test', ref: 'group', did: groupDid });
    const transferId = await propose();
    const request = (metadata: unknown) => new NextRequest('http://localhost/registry/api/identity', {
      method: 'POST', body: JSON.stringify({ namespace: 'test', ref: 'group', type: 'business', metadata }),
    });
    for (const value of [null, {}, { id: transferId, from: owner, to: stranger, by: stranger, policy: 'owner-only', createdAt: new Date().toISOString() }]) {
      expect((await REGISTRY_IDENTITY(request({ [PENDING_OWNER_TRANSFER_KEY]: value }))).status).toBe(400);
    }
    const [edit] = await Promise.all([
      REGISTRY_IDENTITY(request({ extra: 'kept' })),
      ownershipTransfer(groupDid, { id: recipient }, 'accept', { transferId }),
    ]);
    expect(edit.status).toBe(200);
    const [group] = await database.select().from(authSchema.identities).where(eq(authSchema.identities.id, groupDid));
    expect(group.metadata).toEqual({ unrelated: { kept: true }, extra: 'kept' });
  });

  it('cannot remove a group owner by passing a group DID to the agent revocation endpoint', async () => {
    expect((await REVOKE_AGENT(new NextRequest('http://localhost', { method: 'DELETE' }), {
      params: Promise.resolve({ did: groupDid }),
    })).status).toBe(404);
    expect(await rows()).toContainEqual(expect.objectContaining({ memberDid: owner, role: 'owner', removedAt: null }));
  });
  it.each([recipient, stranger, agent])('denies proposal by non-owner %s', async (did) => {
    as(did);
    expect((await call(POST, { newOwnerDid: stranger })).response.status).toBe(403);
  });

  it('denies agents on all operations with the shared countersign code; approval headers cannot bypass it', async () => {
    const transferId = await propose();
    as(agent, { actingFor: owner });
    for (const [handler, body, method] of [
      [POST, { newOwnerDid: stranger }, 'POST'], [DELETE, { transferId }, 'DELETE'], [ACCEPT, { transferId }, 'POST'],
    ] as const) {
      const result = await call(handler, body, method);
      expect(result.response.status).toBe(403);
      expect(result.body).toMatchObject({ code: 'AGENT_APPROVAL_REQUIRED', class: 'value-moving' });
    }
    as(owner, { actingAs: groupDid });
    expect((await call(DELETE, { transferId }, 'DELETE')).response.status).toBe(200);
  });

  it('denies wrong recipient, nonmember reads and non-owner cancellation', async () => {
    const transferId = await propose();
    as(stranger);
    expect((await call(GET, undefined, 'GET')).response.status).toBe(403);
    expect((await call(ACCEPT, { transferId })).response.status).toBe(403);
    as(recipient);
    expect((await call(DELETE, { transferId }, 'DELETE')).response.status).toBe(403);
  });

  it.each([agent, groupDid, 'missing', owner])('rejects invalid/nonhuman target %s', async (did) => {
    expect((await call(POST, { newOwnerDid: did })).response.status).toBe(400);
  });

  it('rejects suspended human targets and rechecks suspension at acceptance', async () => {
    await database.update(authSchema.identities).set({ suspendedAt: new Date() }).where(eq(authSchema.identities.id, recipient));
    expect((await call(POST, { newOwnerDid: recipient })).response.status).toBe(400);
    await database.update(authSchema.identities).set({ suspendedAt: null }).where(eq(authSchema.identities.id, recipient));
    const transferId = await propose();
    await database.update(authSchema.identities).set({ suspendedAt: new Date() }).where(eq(authSchema.identities.id, recipient));
    as(recipient);
    expect((await call(ACCEPT, { transferId })).response.status).toBe(400);
  });

  it.each([null, [], {}, { newOwnerDid: 5 }, { newOwnerDid: '' }])('validates proposal JSON %j', async (body) => {
    expect((await call(POST, body)).response.status).toBe(400);
  });

  it('returns auth/JSON errors and CORS preflight', async () => {
    mocks.auth.mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });
    expect((await call(GET, undefined, 'GET')).response.status).toBe(401);
    const invalid = await POST(new NextRequest('http://localhost', { method: 'POST', body: '{' }), params());
    expect(invalid.status).toBe(400);
    const preflight = OPTIONS(new NextRequest('http://localhost', { method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.has('access-control-allow-methods')).toBe(true);
  });

  it('denies unknown policies and consults an injected replacement on propose, cancel and accept', async () => {
    await database.insert(nodeConfig).values({ key: OWNERSHIP_POLICY_KEY, value: 'replacement' });
    expect((await call(POST, { newOwnerDid: recipient })).body).toMatchObject({ code: 'OWNERSHIP_POLICY_UNKNOWN' });
    const replacement = vi.fn(ownershipPolicies['owner-only']);
    const registry = { replacement };
    const proposal = await ownershipTransfer(groupDid, { id: owner }, 'propose', { newOwnerDid: recipient }, registry);
    const transferId = 'pendingTransfer' in proposal ? proposal.pendingTransfer!.id : '';
    await ownershipTransfer(groupDid, { id: owner }, 'cancel', { transferId }, registry);
    const second = await ownershipTransfer(groupDid, { id: owner }, 'propose', { newOwnerDid: recipient }, registry);
    const secondId = 'pendingTransfer' in second ? second.pendingTransfer!.id : '';
    await ownershipTransfer(groupDid, { id: recipient }, 'accept', { transferId: secondId }, registry);
    expect(replacement.mock.calls.map(([ctx]) => ctx.action)).toEqual(expect.arrayContaining(['propose', 'cancel', 'accept']));
  });

  it('rechecks selected policy after proposal and fails closed on malformed pending metadata', async () => {
    const transferId = await propose();
    await database.insert(nodeConfig).values({ key: OWNERSHIP_POLICY_KEY, value: 'replacement' });
    await expect(ownershipTransfer(groupDid, { id: recipient }, 'accept', { transferId }, {
      replacement: () => true,
    })).rejects.toMatchObject({ status: 409 });
    expect(() => readPendingTransfer({ [PENDING_OWNER_TRANSFER_KEY]: { id: 'forged' } })).toThrow();
  });

  it('a swapped deny policy is a real authorization gate, not merely a reported name', async () => {
    const deny = vi.fn(() => false);
    await expect(ownershipTransfer(groupDid, { id: owner }, 'propose', { newOwnerDid: recipient }, {
      'owner-only': deny,
    })).rejects.toMatchObject({ status: 403 });
    expect(deny).toHaveBeenCalledWith(expect.objectContaining({ action: 'propose' }));
  });

  it('never grants owner via controllers and cannot delete an owner before or after transfer', async () => {
    expect((await ADD(new NextRequest('http://localhost', {
      method: 'POST', body: JSON.stringify({ did: stranger, role: 'owner' }),
    }), params())).status).toBe(400);
    expect((await REMOVE(new NextRequest('http://localhost', { method: 'DELETE' }), {
      params: Promise.resolve({ groupDid, controllerDid: owner }),
    })).status).toBe(400);
    const transferId = await propose();
    await ownershipTransfer(groupDid, { id: recipient }, 'accept', { transferId });
    as(owner);
    expect((await REMOVE(new NextRequest('http://localhost', { method: 'DELETE' }), {
      params: Promise.resolve({ groupDid, controllerDid: recipient }),
    })).status).toBe(400);
  });
});
