import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { setVaultInternalApiKey } from '../../../../../../packages/auth/tests/support/internal-post-test-env';

// A stateful query double evaluates the actual DID predicates, rather than
// returning the expected owner's rows regardless of what the route queried.
const { data, db, tables, publish, resolveSpy, sessionSpy, listConnections } = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type Predicate = (row: Row) => boolean;
  const data: Record<string, Row[]> = {};
  const tables = Object.fromEntries(['invites', 'profiles', 'pods', 'podMembers', 'identities', 'attestations']
    .map((name) => [name, new Proxy({ table: name }, {
      get: (target, key: string) => key === 'table' ? target.table : key,
    })]));
  function query(kind: string, selection?: Row) {
    let table = '';
    let predicate: Predicate = () => true;
    let values: Row = {};
    let joined = false;
    const run = () => {
      const rows = (data[table] ?? []).filter(predicate);
      if (kind === 'update') rows.forEach((row) => Object.assign(row, values));
      if (kind === 'delete') data[table] = (data[table] ?? []).filter((row) => !predicate(row));
      if (kind === 'insert') {
        const row = { status: 'pending', delivery: 'link', removedAt: null, ...values };
        (data[table] ??= []).push(row);
        return [row];
      }
      if (selection?.count) {
        if (selection.podId) {
          const counts = new Map<unknown, number>();
          for (const row of rows) counts.set(row.podId, (counts.get(row.podId) ?? 0) + 1);
          return Array.from(counts, ([podId, count]) => ({ podId, count }));
        }
        return [{ count: rows.length }];
      }
      if (joined) return rows.map((invite) => ({ invite, acceptedHandle: null, acceptedName: null }));
      return rows;
    };
    const chain = {
      from: (t: { table: string }) => { table = t.table; return chain; },
      where: (p: Predicate) => { predicate = p; return chain; },
      values: (v: Row) => { values = v; return chain; },
      set: (v: Row) => { values = v; return chain; },
      leftJoin: () => { joined = true; return chain; },
      limit: () => Promise.resolve(run()),
      returning: () => Promise.resolve(run()),
      orderBy: () => Promise.resolve(run()),
      groupBy: () => Promise.resolve(run()),
      then: (resolve: (rows: Row[]) => unknown) => Promise.resolve(run()).then(resolve),
    };
    return chain;
  }
  return {
    data, tables,
    db: {
      select: (selection?: Row) => query('select', selection),
      insert: (table: { table: string }) => query('insert').from(table),
      update: (table: { table: string }) => query('update').from(table),
      delete: (table: { table: string }) => query('delete').from(table),
    },
    publish: vi.fn(async (_event: string, _envelope: { payload: Record<string, unknown> }) => undefined),
    resolveSpy: vi.fn(),
    sessionSpy: vi.fn(),
    listConnections: vi.fn(async () => []),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: unknown) => (row: Record<string, unknown>) => row[column] === value,
  ne: (column: string, value: unknown) => (row: Record<string, unknown>) => row[column] !== value,
  and: (...predicates: Array<(row: object) => boolean>) => (row: object) => predicates.every((p) => p(row)),
  or: (...predicates: Array<(row: object) => boolean>) => (row: object) => predicates.some((p) => p(row)),
  isNull: (column: string) => (row: Record<string, unknown>) => row[column] == null,
  isNotNull: (column: string) => (row: Record<string, unknown>) => row[column] != null,
  inArray: (column: string, values: unknown[]) => (row: Record<string, unknown>) => values.includes(row[column]),
  sql: () => 'count',
  count: () => 'count',
  desc: (column: string) => column,
}));
vi.mock('@/src/db', () => ({ db, ...tables }));
// Relationship-label imports now reach node identity, whose raw SQL client
// bypasses the mocked Drizzle DB. Keep real auth without requiring Postgres.
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@/src/lib/connections/list', () => ({ listConnections }));
vi.mock('@imajin/auth', async () => {
  const { resolveEffectiveDid } = await import('../../../../../../packages/auth/src/resolve-effective-did');
  const { requireAuth } = await import('../../../../../../packages/auth/src/require-auth');
  return {
    resolveEffectiveDid: (...args: Parameters<typeof resolveEffectiveDid>) => {
      resolveSpy(...args);
      return resolveEffectiveDid(...args);
    },
    requireAuth,
    isVerifiedTier: () => true,
  };
});
vi.mock('@/src/lib/kernel/session', () => ({
  getSessionForDid: async (did: string) => {
    sessionSpy(did);
    return data.identities.find((identity) => identity.did === did) ?? null;
  },
}));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: () => 'created' }));
vi.mock('@/src/lib/kernel/lookup', () => ({ lookupIdentity: async () => null }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}), corsOptions: () => new Response(),
  withCors: (response: Response) => response,
}));
vi.mock('@imajin/config', () => ({
  SESSION_COOKIE_NAME: 'imajin_session',
  corsHeaders: () => ({}), corsOptions: () => new Response(),
  buildPublicUrl: () => 'https://example.test/connections',
}));
vi.mock('@imajin/bus', () => ({ publish }));
vi.mock('@imajin/email', () => ({ trustGraphInviteEmail: () => '' }));
vi.mock('@/src/lib/mail/send', () => ({ sendKernelEmail: vi.fn() }));
vi.mock('@/src/lib/auth/claimable-stub', () => ({
  resolveOrMintInviteTarget: vi.fn(),
  withNoDisclosure: (invite: Record<string, unknown>) => invite.status === 'accepted' ? invite : { ...invite, toDid: null },
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  withLogger: (_service: string, handler: (request: Request, ctx: object) => unknown) =>
    (request: Request) => handler(request, { log: { error: vi.fn() } }),
}));

import * as invites from '../invites/route';
import * as inviteCode from '../invites/[code]/route';
import * as invitedBy from '../invites/invited-by/route';
import * as groups from '../groups/route';
import * as group from '../groups/[id]/route';
import * as members from '../groups/[id]/members/route';
import * as connections from '../connections/route';

const PERSON = 'did:imajin:person';
const ORG = 'did:imajin:org';
const OTHER = 'did:imajin:other';
const props = { params: Promise.resolve({ id: 'org-group', code: 'org-code' }) };
let controllerRole: string;
let allowedServices: string[] | null;

function request(acting = false, body?: object) {
  return new NextRequest('https://example.test/connections/api', {
    method: body ? 'POST' : 'GET',
    headers: { cookie: `imajin_session=test${acting ? `; x-acting-as=${ORG}` : ''}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_SERVICE_URL', 'https://auth.test');
  setVaultInternalApiKey('test-key');
  controllerRole = 'owner';
  allowedServices = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/session')) return Response.json({ did: PERSON, scope: 'actor' });
    if (url.includes('/controllers/')) return Response.json({ valid: true, role: controllerRole, allowedServices });
    throw new Error(`Unexpected auth URL: ${url}`);
  }));
  data.identities = [
    { did: PERSON, tier: 'preliminary', chainVerified: true },
    { did: ORG, tier: 'established', chainVerified: true },
  ];
  data.invites = [
    { id: 'org-invite', code: 'org-code', fromDid: ORG, delivery: 'link', status: 'pending' },
    { id: 'personal-invite', code: 'personal-code', fromDid: PERSON, delivery: 'link', status: 'pending' },
  ];
  data.profiles = [{ did: ORG }, { did: PERSON }];
  data.pods = [
    { id: 'org-group', ownerDid: ORG, type: 'shared', conversationDid: null },
    { id: 'personal-group', ownerDid: PERSON, type: 'shared', conversationDid: null },
  ];
  data.podMembers = [
    { podId: 'org-group', did: ORG, role: 'owner', removedAt: null },
    { podId: 'personal-group', did: PERSON, role: 'owner', removedAt: null },
  ];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setVaultInternalApiKey(undefined);
});

describe.each([false, true])('connections identity isolation (acting as org: %s)', (acting) => {
  const did = acting ? ORG : PERSON;
  const otherDid = acting ? PERSON : ORG;
  const id = acting ? 'org-group' : 'personal-group';
  const ownProps = { params: Promise.resolve({ id }) };

  it('lists only the effective DID invites and its tier quota', async () => {
    const response = await invites.GET(request(acting));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.invites.map((invite: { fromDid: string }) => invite.fromDid)).toEqual([did]);
    expect(body).toMatchObject({ limit: acting ? 20 : 5, pending: 1, remaining: acting ? 19 : 4 });
    expect(sessionSpy).toHaveBeenCalledWith(did);
    expect(resolveSpy).toHaveBeenCalledWith(expect.anything(), { scope: 'connections:read', service: 'connections' });
  });

  it('creates, immediately lists, and revokes an invite as the same identity', async () => {
    const created = await invites.POST(request(acting, {}));
    expect(created.status).toBe(201);
    const { invite } = await created.json();
    expect(invite.fromDid).toBe(did);
    const listed = await (await invites.GET(request(acting))).json();
    expect(listed.invites.map((row: { id: string }) => row.id)).toContain(invite.id);
    expect(listed.invites.every((row: { fromDid: string }) => row.fromDid === did)).toBe(true);
    const revoked = await inviteCode.DELETE(request(acting), { params: Promise.resolve({ code: invite.code }) });
    expect(revoked.status).toBe(200);
    expect(data.invites.find((row) => row.code === invite.code)?.status).toBe('revoked');
    expect(resolveSpy).toHaveBeenCalledWith(expect.anything(), { scope: 'connections:write', service: 'connections' });
  });

  it('cannot revoke the other identity invite or clear its cooldown', async () => {
    const code = acting ? 'personal-code' : 'org-code';
    const response = await inviteCode.DELETE(request(acting), { params: Promise.resolve({ code }) });
    expect(response.status).toBe(403);
    expect(data.invites.find((row) => row.code === code)?.status).toBe('pending');
  });

  it('enforces create quota against only the effective DID pending invites', async () => {
    data.invites = Array.from({ length: acting ? 20 : 5 }, (_, index) => ({
      id: `pending-${index}`, fromDid: did, delivery: 'link', status: 'pending',
    }));
    expect((await invites.POST(request(acting, {}))).status).toBe(429);
    expect(data.invites.every((invite) => invite.fromDid === did)).toBe(true);
  });

  it('clears only the effective sender email cooldown on revoke', async () => {
    data.invites[acting ? 0 : 1].delivery = 'email';
    data.profiles.forEach((profile) => { profile.nextInviteAvailableAt = 'tomorrow'; });
    const code = acting ? 'org-code' : 'personal-code';
    expect((await inviteCode.DELETE(request(acting), { params: Promise.resolve({ code }) })).status).toBe(200);
    expect(data.profiles.find((profile) => profile.did === did)?.nextInviteAvailableAt).toBeNull();
    expect(data.profiles.find((profile) => profile.did === otherDid)?.nextInviteAvailableAt).toBe('tomorrow');
  });

  it.each(['consumedBy', 'toDid'])('looks up invited-by using the effective %s DID', async (field) => {
    data.invites = [
      { [field]: PERSON, fromDid: 'personal-inviter', status: 'accepted' },
      { [field]: ORG, fromDid: 'org-inviter', status: 'accepted' },
    ];
    const response = await invitedBy.GET(request(acting));
    expect((await response.json()).invitedBy.did).toBe(acting ? 'org-inviter' : 'personal-inviter');
  });

  it('returns no invited-by instead of leaking the personal introducer', async () => {
    data.invites = [{ consumedBy: otherDid, fromDid: OTHER }];
    expect(await (await invitedBy.GET(request(acting))).json()).toEqual({ invitedBy: null });
  });

  it('lists only groups the effective DID belongs to', async () => {
    const response = await groups.GET(request(acting));
    expect((await response.json()).pods.map((pod: { id: string }) => pod.id)).toEqual([id]);
  });

  it('includes non-owned memberships but excludes removed and personal pods', async () => {
    data.pods.push(
      { id: 'member-only', ownerDid: OTHER, type: 'shared' },
      { id: 'removed', ownerDid: OTHER, type: 'shared' },
      { id: 'connection-pod', ownerDid: did, type: 'personal' },
    );
    data.podMembers.push(
      { podId: 'member-only', did, removedAt: null },
      { podId: 'removed', did, removedAt: 'yesterday' },
      { podId: 'connection-pod', did, removedAt: null },
    );
    const body = await (await groups.GET(request(acting))).json();
    expect(body.pods.map((pod: { id: string }) => pod.id)).toEqual([id, 'member-only']);
  });

  it('creates groups with the effective owner and records member attribution', async () => {
    const response = await groups.POST(request(acting, { name: 'New group', memberDids: [did, OTHER] }));
    expect(response.status).toBe(201);
    expect((await response.json()).pod).toMatchObject({ ownerDid: did, memberCount: 2 });
    expect(data.podMembers.filter((row) => row.podId === 'created')).toEqual([
      expect.objectContaining({ did, role: 'owner', addedBy: did }),
      expect.objectContaining({ did: OTHER, role: 'member', addedBy: did }),
    ]);
  });

  it('reads, edits and deletes its own group', async () => {
    expect((await group.GET(request(acting), ownProps)).status).toBe(200);
    const updated = await group.PATCH(request(acting, { name: 'Updated' }), ownProps);
    expect(updated.status).toBe(200);
    expect((await updated.json()).pod.ownerDid).toBe(did);
    expect((await group.DELETE(request(acting), ownProps)).status).toBe(200);
    expect(data.pods.map((pod) => pod.id)).not.toContain(id);
  });

  it('denies reads, edits and deletes of the other identity group', async () => {
    const foreign = { params: Promise.resolve({ id: acting ? 'personal-group' : 'org-group' }) };
    expect((await group.GET(request(acting), foreign)).status).toBe(403);
    expect((await group.PATCH(request(acting, { name: 'Stolen' }), foreign)).status).toBe(404);
    expect((await group.DELETE(request(acting), foreign)).status).toBe(404);
    expect(data.pods).toHaveLength(2);
  });

  it('uses effective membership for conversation linkage, without granting ownership', async () => {
    data.pods.find((pod) => pod.id === id)!.ownerDid = OTHER;
    const response = await group.PATCH(request(acting, { conversationDid: 'conversation' }), ownProps);
    expect(response.status).toBe(200);
    expect((await response.json()).pod.conversationDid).toBe('conversation');
    expect((await group.PATCH(request(acting, { name: 'Not owner' }), ownProps)).status).toBe(404);
    const foreign = { params: Promise.resolve({ id: acting ? 'personal-group' : 'org-group' }) };
    expect((await group.PATCH(request(acting, { conversationDid: 'forbidden' }), foreign)).status).toBe(403);
  });

  it.each([
    ['POST', 'pod.member.added', 201],
    ['PATCH', 'pod.role.changed', 200],
    ['DELETE', 'pod.member.removed', 200],
  ] as const)('%s members authorizes the effective owner and publishes its issuer/actor', async (method, event, status) => {
    if (method !== 'POST') data.podMembers.push({ podId: id, did: OTHER, role: 'member', removedAt: null });
    const response = await members[method](request(acting, { did: OTHER, role: 'admin' }), ownProps);
    expect(response.status).toBe(status);
    expect(publish).toHaveBeenCalledWith(event, expect.objectContaining({
      issuer: did, subject: OTHER,
      payload: expect.objectContaining({ context_id: id, ...(acting ? { actorDid: PERSON } : {}) }),
    }));
    const payload = publish.mock.calls[0][1].payload;
    if (!acting) expect(payload).not.toHaveProperty('actorDid');
    if (method === 'POST') expect(data.podMembers.find((row) => row.did === OTHER)?.addedBy).toBe(did);
    expect(sessionSpy).toHaveBeenCalledWith(did);
  });

  it.each(['POST', 'PATCH', 'DELETE'] as const)('%s members denies the other identity owner', async (method) => {
    const foreign = { params: Promise.resolve({ id: acting ? 'personal-group' : 'org-group' }) };
    expect((await members[method](request(acting, { did: OTHER, role: 'admin' }), foreign)).status).toBe(403);
    expect(publish).not.toHaveBeenCalled();
  });

  it('cannot remove the effective owner from its group', async () => {
    expect((await members.DELETE(request(acting, { did }), ownProps)).status).toBe(400);
    expect(publish).not.toHaveBeenCalled();
  });
});

const routes = [
  ['connections list', (req: NextRequest) => connections.GET(req), 'read'],
  ['invite list', (req: NextRequest) => invites.GET(req), 'read'],
  ['invite create', (req: NextRequest) => invites.POST(req), 'write'],
  ['invite revoke', (req: NextRequest) => inviteCode.DELETE(req, props), 'write'],
  ['invited-by', (req: NextRequest) => invitedBy.GET(req), 'read'],
  ['groups list', (req: NextRequest) => groups.GET(req), 'read'],
  ['groups create', (req: NextRequest) => groups.POST(req), 'write'],
  ['group read', (req: NextRequest) => group.GET(req, props), 'read'],
  ['group edit', (req: NextRequest) => group.PATCH(req, props), 'write'],
  ['group delete', (req: NextRequest) => group.DELETE(req, props), 'write'],
  ['member add', (req: NextRequest) => members.POST(req, props), 'write'],
  ['member change', (req: NextRequest) => members.PATCH(req, props), 'write'],
  ['member remove', (req: NextRequest) => members.DELETE(req, props), 'write'],
] as const;

describe.each(routes)('%s auth boundary', (_name, handler, scope) => {
  it.each([{ services: null }, { services: ['connections'] }])('allows a maintainer with $services access as the org', async ({ services }) => {
    controllerRole = 'maintainer';
    allowedServices = services;
    if (_name === 'member change' || _name === 'member remove') {
      data.podMembers.push({ podId: 'org-group', did: OTHER, role: 'member', removedAt: null });
    }
    const response = await handler(request(true, { name: 'Allowed', did: OTHER, role: 'admin' }));
    expect(response.status).toBe(_name.endsWith('create') || _name === 'member add' ? 201 : 200);
    if (_name === 'connections list') expect(listConnections).toHaveBeenCalledWith(ORG);
    expect(resolveSpy).toHaveBeenCalledWith(expect.anything(), {
      scope: `connections:${scope}`, service: 'connections',
    });
  });
  it.each([{ services: ['pay'] }, { services: [] }])('refuses service-restricted maintainers ($services) before reading or writing data', async ({ services }) => {
    controllerRole = 'maintainer';
    allowedServices = services;
    const before = structuredClone(data);
    const response = await handler(request(true, { name: 'Denied', did: OTHER, role: 'admin' }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Not authorized to act as this group' });
    expect(data).toEqual(before);
    expect(sessionSpy).not.toHaveBeenCalled();
    expect(listConnections).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
  it('refuses a plain member attempting act-as, never falls back to personal data', async () => {
    controllerRole = 'member';
    const response = await handler(request(true, { name: 'Denied', did: OTHER, role: 'admin' }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Not authorized to act as this group' });
    expect(resolveSpy).toHaveBeenCalledWith(expect.anything(), { scope: `connections:${scope}`, service: 'connections' });
    expect(data.pods).toHaveLength(2);
    expect(data.invites).toHaveLength(2);
    expect(publish).not.toHaveBeenCalled();
  });

  it('requires authentication even without an act-as overlay', async () => {
    const response = await handler(new NextRequest('https://example.test/connections/api'));
    expect(response.status).toBe(401);
  });

  it('preserves the app scope refusal without falling back to a personal session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: `Scope 'connections:${scope}' was not granted` }, { status: 403 },
    )));
    const response = await handler(new NextRequest('https://example.test/connections/api', {
      headers: { authorization: 'Bearer app-token', cookie: 'imajin_session=test' },
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: `Scope 'connections:${scope}' was not granted` });
  });
});

it.each(['owner', 'admin', 'maintainer'])('allows %s to operate the org group', async (role) => {
  controllerRole = role;
  const response = await members.POST(request(true, { did: OTHER }), props);
  expect(response.status).toBe(201);
  expect(publish).toHaveBeenCalledWith('pod.member.added', expect.objectContaining({ issuer: ORG }));
});

it('keeps the chain-verification event guard on the effective identity', async () => {
  data.identities.find((identity) => identity.did === ORG)!.chainVerified = false;
  expect((await members.POST(request(true, { did: OTHER }), props)).status).toBe(201);
  expect(publish).not.toHaveBeenCalled();
});
