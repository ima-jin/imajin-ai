import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PGlite } from '@electric-sql/pglite';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('@/src/lib/auth/jwt', () => ({ verifyAppServiceToken: mocks.verify }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://events.example' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/db', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy');
  const connections = await import('@/src/db/schemas/connections');
  const auth = await import('@/src/db/schemas/auth');
  const registry = await import('@/src/db/schemas/registry');
  return {
    db: drizzle(mocks.execute),
    pods: connections.podsInConnections,
    podMembers: connections.podMembersInConnections,
    channelLinks: auth.channelLinks,
    registryApps: registry.registryApps,
  };
});

import { GET as list, OPTIONS as listOptions, dynamic as listDynamic } from '@/app/connections/api/apps/pods/route';
import { GET as members, OPTIONS as memberOptions, dynamic as memberDynamic } from '@/app/connections/api/apps/pods/[id]/members/route';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const APP = 'did:imajin:events';
const TARGET = 'did:imajin:cohost';
const POD = 'pod_event';
const JOINED = '2026-10-17 12:00:00';

function request(query = '', headers: Record<string, string> = { authorization: 'Bearer fixture-token' }) {
  return new NextRequest(`https://kernel.example/connections/api/apps/pods${query}`, { headers });
}

function readMembers(req = request(), id = POD) {
  return members(req, { params: Promise.resolve({ id }) });
}

function queryCall(index: number) {
  const [sql, params] = mocks.execute.mock.calls[index] as [string, unknown[]];
  return { sql, params };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue({ appDid: APP, scopes: ['connections:read'] });
  mocks.execute.mockImplementation(async (sql: string) => ({
    rows: sql.includes('"registry"."apps"') ? [[APP]] : [],
  }));
});

describe('app-service identity and live approval', () => {
  it.each([
    {},
    { cookie: 'imajin_session=fixture-session' },
    { 'x-app-did': APP, 'x-app-authorization': 'fixture-attestation' },
    { authorization: 'Basic fixture' },
  ])('rejects non-service credentials without querying membership: %j', async (headers) => {
    const response = await readMembers(request('', headers));
    expect(response.status).toBe(401);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('fails closed on a rejected token, even with a session and spoofed acting DID', async () => {
    mocks.verify.mockResolvedValue(null);
    const response = await readMembers(request('', {
      authorization: 'Bearer rejected-token', cookie: 'imajin_session=fixture',
      'x-acting-for': 'did:imajin:owner',
    }));
    expect(response.status).toBe(401);
    expect(mocks.verify).toHaveBeenCalledWith('rejected-token');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('requires the scope on the token before querying the registry', async () => {
    mocks.verify.mockResolvedValue({ appDid: APP, scopes: ['profile:read'] });
    expect((await readMembers()).status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('requires the exact app registration, active status and current operator approval in SQL', async () => {
    await readMembers();
    const { sql, params } = queryCall(0);
    expect(sql).toContain('"registry"."apps"."app_did" = $1');
    expect(sql).toContain('"registry"."apps"."status" = $2');
    expect(sql).toContain('"registry"."apps"."approved_service_scopes" @> $3');
    expect(params).toEqual([APP, 'active', '["connections:read"]', 1]);
  });

  it('rejects a missing/inactive/unapproved registry row without a membership read', async () => {
    mocks.execute.mockResolvedValue({ rows: [] });
    expect((await readMembers()).status).toBe(403);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});

function assertOwnerFence(sql: string, params: unknown[], appDid = APP) {
  expect(sql).toContain('exists (select');
  expect(sql).toContain('"auth"."channel_links"."did" = "connections"."pods"."owner_did"');
  expect(sql).toMatch(/"auth"\."channel_links"\."channel" = \$\d+/);
  expect(sql).toMatch(/"auth"\."channel_links"\."app_did" = \$\d+/);
  expect(sql).toMatch(/"auth"\."channel_links"\."status" = \$\d+/);
  expect(sql).toContain('"auth"."channel_links"."revoked_at" is null');
  expect(sql).toMatch(/"auth"\."channel_links"\."scopes" @> \$\d+/);
  expect(params).toEqual(expect.arrayContaining(['app', appDid, 'active', '["connections:read"]']));
}

describe('by-pod membership', () => {
  it('returns minimal active direct roles, including cohosts, without pod metadata', async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [[APP]] }).mockResolvedValueOnce({
      rows: [[POD, TARGET, 'cohost', JOINED], [POD, 'did:imajin:owner', 'owner', JOINED]],
    });
    const response = await readMembers();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      podId: POD,
      members: [
        { podId: POD, did: TARGET, role: 'cohost', joinedAt: JOINED },
        { podId: POD, did: 'did:imajin:owner', role: 'owner', joinedAt: JOINED },
      ],
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://events.example');
  });

  it('filters removed members in the left join and scopes the pod inside SQL', async () => {
    await readMembers();
    const { sql, params } = queryCall(1);
    expect(sql).toContain('left join "connections"."pod_members"');
    expect(sql).toContain('"connections"."pod_members"."pod_id" = "connections"."pods"."id"');
    expect(sql).toContain('"connections"."pod_members"."removed_at" is null');
    expect(sql).toContain('"connections"."pods"."id" = $1');
    expect(params[0]).toBe(POD);
    assertOwnerFence(sql, params);
  });

  it('returns [] for an entitled pod with no active members', async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [[APP]] })
      .mockResolvedValueOnce({ rows: [[POD, null, null, null]] });
    expect(await (await readMembers()).json()).toEqual({ podId: POD, members: [] });
  });

  it('does not distinguish nonexistent, other-owner, other-app or revoked-grant pods', async () => {
    const response = await readMembers();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Pod not found' });
    assertOwnerFence(queryCall(1).sql, queryCall(1).params);
  });

  it('does not allow another registered app, even with the same registry owner, to reuse the grant', async () => {
    mocks.verify.mockResolvedValue({ appDid: 'did:imajin:other-app', scopes: ['connections:read'] });
    const response = await readMembers(request('?appDid=did:imajin:events&ownerDid=did:imajin:owner', {
      authorization: 'Bearer other-app-token', 'x-app-did': APP, 'x-acting-for': 'did:imajin:owner',
    }));
    expect(response.status).toBe(404);
    const { sql, params } = queryCall(1);
    assertOwnerFence(sql, params, 'did:imajin:other-app');
    expect(params).not.toContain(APP);
    expect(params).not.toContain('did:imajin:owner');
  });
});

describe('reverse membership lookup', () => {
  it('returns only pod IDs for the explicit target under the same owner/app fence', async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [[APP]] })
      .mockResolvedValueOnce({ rows: [['pod_a'], ['pod_b']] });
    const response = await list(request(`?did=${encodeURIComponent(TARGET)}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ podIds: ['pod_a', 'pod_b'] });
    const { sql, params } = queryCall(1);
    assertOwnerFence(sql, params);
    expect(sql).toContain('"connections"."pod_members"."did" = $1');
    expect(params[0]).toBe(TARGET);
    expect(sql).toContain('"connections"."pod_members"."removed_at" is null');
    expect(sql).toContain('order by "connections"."pods"."id"');
  });

  it('returns an empty list for no entitled active memberships, never all of a DID’s pods', async () => {
    const response = await list(request(`?did=${TARGET}&ownerDid=did:imajin:other-owner`));
    expect(await response.json()).toEqual({ podIds: [] });
    const { sql, params } = queryCall(1);
    assertOwnerFence(sql, params);
    expect(params).not.toContain('did:imajin:other-owner');
  });

  it.each(['', '?did=', '?did=not-a-did', '?did=%20did:imajin:target', `?did=did:${'a'.repeat(2048)}`])(
    'rejects invalid target %s without running a membership query', async (query) => {
      expect((await list(request(query))).status).toBe(400);
      expect(mocks.execute).toHaveBeenCalledTimes(1);
    },
  );
});

describe('failure handling and route contract', () => {
  it.each([0, 1])('fails closed when database query %s throws', async (queryIndex) => {
    if (queryIndex === 1) mocks.execute.mockResolvedValueOnce({ rows: [[APP]] });
    mocks.execute.mockRejectedValueOnce(new Error('database details must not leak'));
    const response = await readMembers();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Pod membership unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('fails closed on verifier failure', async () => {
    mocks.verify.mockRejectedValue(new Error('verification unavailable'));
    expect((await list(request(`?did=${TARGET}`))).status).toBe(503);
  });

  it('exports uncached GETs and preflight on both actual routes', () => {
    expect(listDynamic).toBe('force-dynamic');
    expect(memberDynamic).toBe('force-dynamic');
    expect(listOptions().status).toBe(204);
    expect(memberOptions().status).toBe(204);
  });

  it('publishes both service-only operations in the kernel spec', () => {
    const spec = parse(readFileSync('apps/kernel/api-spec/connections.yaml', 'utf8'));
    for (const path of ['/api/apps/pods', '/api/apps/pods/{id}/members']) {
      expect(spec.paths[path].get.security).toEqual([{ appServiceAuth: [] }]);
      expect(spec.paths[path].get.responses['503']).toBeDefined();
    }
    expect(spec.paths['/api/apps/pods'].get.parameters[0].required).toBe(true);
  });
});

describe('PostgreSQL membership isolation', () => {
  let client: PGlite;
  beforeAll(async () => {
    client = new PGlite();
    await client.exec(`
      CREATE SCHEMA registry;
      CREATE SCHEMA connections;
      CREATE SCHEMA auth;
      CREATE TABLE registry.apps (
        app_did text PRIMARY KEY, owner_did text, status text,
        approved_service_scopes jsonb
      );
      CREATE TABLE connections.pods (id text PRIMARY KEY, owner_did text);
      CREATE TABLE connections.pod_members (
        pod_id text, did text, role text, joined_at timestamp DEFAULT now(),
        removed_at timestamp, PRIMARY KEY (pod_id, did)
      );
      CREATE TABLE auth.channel_links (
        id text PRIMARY KEY, channel text, did text, app_did text, status text,
        scopes jsonb, revoked_at timestamp
      );
    `);
  }, 30_000);
  afterAll(async () => { await client?.close(); });

  beforeEach(async () => {
    await client.exec(`
      TRUNCATE registry.apps, connections.pods, connections.pod_members, auth.channel_links;
      INSERT INTO registry.apps VALUES
        ('did:imajin:events', 'did:imajin:developer', 'active', '["connections:read"]'),
        ('did:imajin:sibling', 'did:imajin:developer', 'active', '["connections:read"]');
      INSERT INTO connections.pods VALUES
        ('pod_event', 'did:imajin:owner-a'), ('pod_other', 'did:imajin:owner-b'),
        ('pod_empty', 'did:imajin:owner-a'), ('pod_removed', 'did:imajin:owner-a');
      INSERT INTO connections.pod_members (pod_id, did, role, removed_at) VALUES
        ('pod_event', 'did:imajin:cohost', 'cohost', null),
        ('pod_event', 'did:imajin:owner-a', 'owner', null),
        ('pod_other', 'did:imajin:cohost', 'cohost', null),
        ('pod_removed', 'did:imajin:cohost', 'cohost', now()),
        ('pod_event', 'did:imajin:removed', 'cohost', now());
      INSERT INTO auth.channel_links VALUES
        ('grant-a', 'app', 'did:imajin:owner-a', 'did:imajin:events', 'active', '["connections:read"]', null),
        ('grant-b', 'app', 'did:imajin:owner-b', 'did:imajin:sibling', 'active', '["connections:read"]', null);
    `);
    mocks.execute.mockImplementation((sql: string, params: unknown[]) =>
      client.query(sql, params, { rowMode: 'array' }));
  });

  it('executes both routes and excludes removed memberships and other owners', async () => {
    const response = await readMembers();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.members.map((member: { did: string; role: string }) => [member.did, member.role]))
      .toEqual([[TARGET, 'cohost'], ['did:imajin:owner-a', 'owner']]);
    expect(await (await list(request(`?did=${TARGET}`))).json()).toEqual({ podIds: [POD] });
    expect(await (await readMembers(request(), 'pod_empty')).json()).toEqual({
      podId: 'pod_empty', members: [],
    });
  });

  it('cannot read another owner’s pod using its known ID or a spoofed owner hint', async () => {
    const response = await readMembers(request('?ownerDid=did:imajin:owner-b', {
      authorization: 'Bearer fixture-token', 'x-acting-for': 'did:imajin:owner-b',
    }), 'pod_other');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(await (await readMembers(request(), 'pod_missing')).json());
  });

  it('cannot reuse another app’s owner grant even when both apps have the same registry owner', async () => {
    mocks.verify.mockResolvedValue({ appDid: 'did:imajin:sibling', scopes: ['connections:read'] });
    expect((await readMembers()).status).toBe(404);
    expect(await (await list(request(`?did=${TARGET}&appDid=${APP}`))).json())
      .toEqual({ podIds: ['pod_other'] });
  });

  it.each([
    "status = 'revoked'",
    'revoked_at = now()',
    "scopes = '[\"profile:read\"]'",
    "channel = 'telegram'",
    "did = 'did:imajin:cohost'",
    "app_did = 'did:imajin:unrelated'",
  ])('immediately refuses owner grants with %s on both routes', async (change) => {
    // The successful read precedes revocation, proving no token/cache bypass.
    expect((await readMembers()).status).toBe(200);
    await client.exec(`UPDATE auth.channel_links SET ${change} WHERE id = 'grant-a'`);
    expect((await readMembers()).status).toBe(404);
    expect(await (await list(request(`?did=${TARGET}`))).json()).toEqual({ podIds: [] });
  });

  it.each([
    "status = 'revoked'",
    "approved_service_scopes = '[]'",
    "app_did = 'did:imajin:no-longer-registered'",
  ])('immediately refuses registry changes: %s', async (change) => {
    expect((await readMembers()).status).toBe(200);
    await client.exec(`UPDATE registry.apps SET ${change} WHERE app_did = 'did:imajin:events'`);
    expect((await readMembers()).status).toBe(403);
    expect((await list(request(`?did=${TARGET}`))).status).toBe(403);
  });
});
