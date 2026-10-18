import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { parse } from 'yaml';
import { SCOPE_VOCABULARY } from '@imajin/auth/scope-vocabulary';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const h = vi.hoisted(() => ({
  db: null as unknown, fail: false, failure: null as unknown,
  tokens: new Map<string, Record<string, unknown>>(), log: vi.fn(),
}));
vi.mock('@/src/db', async () => {
  const chat = await import('@/src/db/schemas/chat-v2');
  const auth = await import('@/src/db/schemas/auth');
  const registry = await import('@/src/db/schemas/registry');
  const db = new Proxy({}, {
    get: (_target, prop) => {
      if (h.fail) throw h.failure ?? new Error('database unavailable: internal detail');
      const target = h.db as Record<string | symbol, unknown>;
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, ...chat, ...auth, ...registry };
});

vi.mock('@/src/lib/auth/jwt', () => ({
  verifyAppToken: async (token: string) => h.tokens.get(token) ?? null,
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: h.log }) }));

import { PUT, OPTIONS, dynamic } from '../route';
import { db, conversationsV2 } from '@/src/db';

const APP = 'did:imajin:eventsapp';
const OTHER_APP = 'did:imajin:otherapp';
const OWNER = 'did:imajin:creator';
const OTHER_OWNER = 'did:imajin:othercreator';
const EVENT = 'did:imajin:eventidentity';
const SESSION = 'eyJ0eXAiOiJKV1QifQ.fixture-session.fixture-signature';
const root = resolve(__dirname, '../../../../../../../..');
const migration = readFileSync(resolve(root, 'migrations/0209_chat_conversations_app_binding.sql'), 'utf8');
const provenanceMigration = readFileSync(resolve(root, 'migrations/0212_identity_registering_app.sql'), 'utf8');
let client: PGlite;
let sessionDid: string | null;

function request(
  body: unknown = { name: 'Event name', createdBy: OWNER },
  token: string | null = 'service',
  cookie: string | null = SESSION,
  extraHeaders: Record<string, string> = {},
) {
  return new NextRequest('https://kernel.test/chat/api/d/' + EVENT, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json', Origin: 'https://app.test',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: `imajin_session=${cookie}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}
function put(req = request(), did = EVENT) {
  return PUT(req, { params: Promise.resolve({ did }) });
}
async function rows() {
  return db.select().from(conversationsV2);
}
async function seed(appDid: string | null = APP, createdBy = OWNER) {
  await db.insert(conversationsV2).values({
    did: EVENT, appDid, createdBy, type: 'group', name: 'Original',
    description: 'Preserve description', avatar: 'asset_original',
    context: { nameDisplayPolicy: 'attendee_choice', appDid: OTHER_APP },
    visibility: 'public', podId: 'pod_original',
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
    lastMessageAt: new Date('2026-01-03'),
  });
}

beforeAll(async () => {
  client = new PGlite({ extensions: { pgcrypto } });
  await client.waitReady;
  for (const file of ['0001_seed.sql', '0007_registry_apps.sql', '0179_registry_apps_approved_service_scopes.sql']) {
    await client.exec(readFileSync(resolve(root, 'migrations', file), 'utf8'));
  }
  await client.exec(migration);
  await client.exec(provenanceMigration);
  h.db = drizzle(client);
});
afterAll(async () => {
  await client?.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  vi.clearAllMocks();
  h.fail = false;
  h.failure = null;
  sessionDid = OWNER;
  vi.stubEnv('AUTH_SERVICE_URL', 'https://kernel.test/auth');
  // Exercise real requireAuth with only its session-verification transport stubbed.
  // These are inert fixtures: no credentials or keys are minted.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/session')) {
      return new Response(JSON.stringify({ did: sessionDid }), { status: sessionDid ? 200 : 401 });
    }
    return new Response(JSON.stringify({ allowed: false }), { status: 403 });
  }));
  h.tokens.clear();
  h.tokens.set('service', { azp: APP, scope: 'chat:write', isServiceToken: true });
  h.tokens.set('other-app', { azp: OTHER_APP, scope: 'chat:write', isServiceToken: true });
  h.tokens.set('delegated', { azp: APP, scope: 'chat:write', isServiceToken: false });
  h.tokens.set('wrong-scope', { azp: APP, scope: 'profile:read', isServiceToken: true });
  await client.exec('TRUNCATE chat.conversations_v2 CASCADE; DELETE FROM auth.identity_members; DELETE FROM auth.identities; DELETE FROM registry.apps;');
  await client.query(
    "INSERT INTO auth.identities (id, public_key, scope, subtype, registered_by_app_did) VALUES ($1, 'fixture-public-key', 'actor', 'event', $2)", [EVENT, APP],
  );
  for (const appDid of [APP, OTHER_APP]) {
    await client.query(
      `INSERT INTO registry.apps (id, app_did, owner_did, name, public_key, callback_url, status, approved_service_scopes)
       VALUES ($1, $1, $2, 'Fixture app', 'fixture-public-key', 'https://app.test', 'active', '["chat:write"]')`,
      [appDid, OWNER],
    );
  }
});

describe('app-owned identity conversation metadata', () => {
  it('creates name, human creator and app binding together before member sync', async () => {
    const response = await put(request({ name: '  Event title  ', createdBy: OWNER }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      conversation: { did: EVENT, name: 'Event title', createdBy: OWNER, appDid: APP },
    });
    expect(await rows()).toMatchObject([{ type: 'group', createdBy: OWNER, appDid: APP }]);
    expect((await client.query('SELECT * FROM chat.conversation_members')).rows).toEqual([]);
  });
  it('allows app attribution without borrowing a human session', async () => {
    expect((await put(request({ name: 'App room', createdBy: APP }, 'service', null))).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('renames and retries without transferring ownership or erasing metadata', async () => {
    await seed();
    const [before] = await rows();
    expect((await put()).status).toBe(200);
    expect((await put()).status).toBe(200);
    const [after] = await rows();
    expect(after).toEqual({ ...before, name: 'Event name', updatedAt: after.updatedAt });
    expect(after.updatedAt!.getTime()).toBeGreaterThan(before.updatedAt!.getTime());
  });
  it('allows service-only renames for the already bound creator', async () => {
    await seed();
    expect((await put(request(undefined, 'service', null))).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([{ name: 'Event name', appDid: APP, createdBy: OWNER }]);
  });
  it.each([OTHER_APP, null])('refuses other-app/legacy binding %s with the same human owner', async (appDid) => {
    await seed(appDid);
    const before = await rows();
    expect((await put()).status).toBe(403);
    expect(await rows()).toEqual(before);
  });
  it('refuses another owner on the same app', async () => {
    await seed(APP, OTHER_OWNER);
    const before = await rows();
    expect((await put()).status).toBe(403);
    expect(await rows()).toEqual(before);
  });
  it('does not use app attribution to take over a human-owned conversation', async () => {
    await seed();
    const before = await rows();
    expect((await put(request({ name: 'Hijacked', createdBy: APP }, 'service', null))).status).toBe(403);
    expect(await rows()).toEqual(before);
  });
  it('atomically chooses one app binding under competing creates', async () => {
    const responses = await Promise.all([put(), put(request(undefined, 'other-app'))]);
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 403]);
    expect(await rows()).toHaveLength(1);
  });
  it('cannot claim legacy rooms through writable context or admin membership', async () => {
    await seed(null);
    await client.query(
      "INSERT INTO chat.conversation_members (conversation_did, member_did, role) VALUES ($1, $2, 'admin')", [EVENT, OWNER],
    );
    await db.update(conversationsV2).set({ context: { appDid: APP } }).where(eq(conversationsV2.did, EVENT));
    const before = await rows();
    expect((await put()).status).toBe(403);
    expect(await rows()).toEqual(before);
  });
});

describe('authentication and creator authority', () => {
  it.each([null, 'invalid', 'expired', 'session-token', 'retired-shared-key'])('rejects non-app credential %s', async (token) => {
    expect((await put(request(undefined, token))).status).toBe(401);
    expect(await rows()).toEqual([]);
  });
  it.each(['delegated', 'wrong-scope'])('rejects %s even with a valid human cookie', async (token) => {
    expect((await put(request(undefined, token))).status).toBe(403);
    expect(await rows()).toEqual([]);
  });
  it('requires the human session and rejects spoofed creator input', async () => {
    expect((await put(request(undefined, 'service', null))).status).toBe(401);
    expect((await put(request({ name: 'Title', createdBy: OTHER_OWNER }))).status).toBe(403);
    expect(await rows()).toEqual([]);
  });
  it('rejects expired sessions and app-service JWTs placed in the cookie', async () => {
    sessionDid = null;
    expect((await put()).status).toBe(401);
    const cookie = 'eyJ0eXAiOiJhcHAtc2VydmljZStqd3QifQ.fixture.fixture';
    expect((await put(request(undefined, 'service', cookie))).status).toBe(401);
    expect(await rows()).toEqual([]);
  });
  it('rejects unverified acting-for delegation', async () => {
    expect((await put(request(undefined, 'service', SESSION, { 'X-Acting-For': OTHER_OWNER }))).status).toBe(403);
    expect(await rows()).toEqual([]);
  });
  it.each(['revoked', 'pending'])('rejects a %s app on every request', async (status) => {
    await client.query('UPDATE registry.apps SET status = $1 WHERE app_did = $2', [status, APP]);
    expect((await put()).status).toBe(403);
    expect(await rows()).toEqual([]);
  });
  it('rejects unregistered apps and live scope revocation', async () => {
    await client.query('UPDATE registry.apps SET approved_service_scopes = $1 WHERE app_did = $2', ['[]', APP]);
    expect((await put()).status).toBe(403);
    await client.query('DELETE FROM registry.apps WHERE app_did = $1', [APP]);
    expect((await put()).status).toBe(403);
    expect(await rows()).toEqual([]);
  });
});

describe('validation and contract', () => {
  it.each([
    null, [], {}, { name: 'Title' }, { name: '', createdBy: OWNER },
    { name: '   ', createdBy: OWNER }, { name: 'x'.repeat(201), createdBy: OWNER },
    { name: 1, createdBy: OWNER }, { name: 'Title', createdBy: 'invalid' },
    { name: 'Title', createdBy: OWNER, appDid: OTHER_APP },
    { name: 'Title', createdBy: OWNER, onBehalfOf: OTHER_OWNER },
    { name: 'Title', createdBy: OWNER, context: { appDid: APP } },
  ])('rejects invalid body %j', async (body) => {
    expect((await put(request(body))).status).toBe(400);
    expect(await rows()).toEqual([]);
  });
  it('rejects malformed JSON and non-event conversation DIDs', async () => {
    const malformed = new NextRequest('https://kernel.test/chat/api/d/' + EVENT, {
      method: 'PUT', headers: { Authorization: 'Bearer service' }, body: '{',
    });
    expect((await put(malformed)).status).toBe(400);
    expect((await put(request(), 'did:imajin:dm:abc')).status).toBe(400);
    expect((await put(request(), 'did:imajin:group:abc')).status).toBe(400);
  });
  it.each(['missing', 'suspended'])('rejects %s identities without disclosing room existence', async (state) => {
    if (state === 'missing') await client.query('DELETE FROM auth.identities WHERE id = $1', [EVENT]);
    if (state === 'suspended') await client.query('UPDATE auth.identities SET suspended_at = NOW() WHERE id = $1', [EVENT]);
    expect((await put()).status).toBe(403);
    expect(await rows()).toEqual([]);
  });
  it('fails closed with a sanitized error if the database fails', async () => {
    h.fail = true;
    const response = await put();
    h.fail = false;
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to update conversation metadata' });
    expect(h.log).toHaveBeenCalledWith({
      status: 500, code: 'APP_CONVERSATION_UPDATE_FAILED',
    }, 'App conversation metadata update failed');
  });
  it.each([
    Object.assign(new Error('must-not-log: duplicate key did:imajin:private-owner'), { code: '08006', token: 'must-not-log' }),
    'must-not-log',
  ])('logs only fixed failure metadata for failure %s', async (failure) => {
    h.fail = true;
    h.failure = failure;
    const response = await put();
    h.fail = false;
    expect(response.status).toBe(500);
    expect(h.log).toHaveBeenCalledWith({
      status: 500, code: 'APP_CONVERSATION_UPDATE_FAILED',
    }, 'App conversation metadata update failed');
    expect(JSON.stringify(h.log.mock.calls)).not.toContain('must-not-log');
    expect(JSON.stringify(h.log.mock.calls)).not.toContain('did:imajin:private-owner');
  });
  it('replays the guarded migration without changing legacy data', async () => {
    await seed(null);
    const before = await rows();
    await client.exec(migration);
    await client.exec(migration);
    expect(await rows()).toEqual(before);
  });
  it('publishes the served YAML contract and keeps chat:write operator-approved only', () => {
    const spec = parse(readFileSync(resolve(root, 'apps/kernel/api-spec/chat.yaml'), 'utf8'));
    expect(spec.paths['/api/d/{did}'].put.operationId).toBe('putAppIdentityConversation');
    expect(spec.paths['/api/d/{did}'].put.requestBody.content['application/json'].schema.required).toEqual(['name', 'createdBy']);
    const entry = SCOPE_VOCABULARY.find((scope) => scope.scope === 'chat:write');
    expect(entry).toBeDefined();
    expect('serviceEligible' in entry!).toBe(false);
    expect(dynamic).toBe('force-dynamic');
    expect(typeof OPTIONS).toBe('function');
  });
});

describe('identity provenance authority (#2926)', () => {
  it.each([false, true])('denies a foreign app before create/rename (room exists: %s)', async (exists) => {
    if (exists) await seed(OTHER_APP, OTHER_APP);
    const before = await rows();
    const response = await put(request({ name: 'Hijacked', createdBy: OTHER_APP }, 'other-app', null));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Identity is not managed by this app or creator' });
    expect(await rows()).toEqual(before);
  });

  it.each(['foreign', 'legacy', 'missing', 'suspended'])('does not expose whether a room exists for %s identities', async (state) => {
    const provenance = state === 'foreign' ? OTHER_APP : null;
    await client.query('UPDATE auth.identities SET registered_by_app_did = $1 WHERE id = $2', [provenance, EVENT]);
    if (state === 'missing') await client.query('DELETE FROM auth.identities WHERE id = $1', [EVENT]);
    if (state === 'suspended') await client.query('UPDATE auth.identities SET suspended_at = NOW() WHERE id = $1', [EVENT]);
    const absent = await put();
    await seed();
    const before = await rows();
    const present = await put();
    expect([absent.status, present.status]).toEqual([403, 403]);
    expect(await absent.json()).toEqual(await present.json());
    expect(await rows()).toEqual(before);
  });

  it.each(['course', 'business', 'human'])('allows registered %s identities without a subtype gate', async (subtype) => {
    await client.query('UPDATE auth.identities SET subtype = $1 WHERE id = $2', [subtype, EVENT]);
    expect((await put()).status).toBe(200);
    expect((await put(request({ name: 'Renamed', createdBy: OWNER }))).status).toBe(200);
    expect(await rows()).toMatchObject([{ name: 'Renamed', appDid: APP }]);
  });

  describe.each(['owner', 'admin'])('%s membership', (role) => {
    it.each([null, OTHER_APP])('allows a member app on legacy/foreign provenance %s', async (provenance) => {
      await client.query('UPDATE auth.identities SET registered_by_app_did = $1 WHERE id = $2', [provenance, EVENT]);
      await client.query(
        'INSERT INTO auth.identity_members (identity_did, member_did, role) VALUES ($1, $2, $3)', [EVENT, APP, role],
      );
      expect((await put(request({ name: 'Member app', createdBy: APP }, 'service', null))).status).toBe(200);
      expect((await put(request({ name: 'Renamed', createdBy: APP }, 'service', null))).status).toBe(200);
      await client.query('UPDATE auth.identity_members SET removed_at = NOW()');
      const before = await rows();
      expect((await put(request({ name: 'Revoked', createdBy: APP }, 'service', null))).status).toBe(403);
      expect(await rows()).toEqual(before);
    });

    it('requires a verified human member on every call, including rename', async () => {
      await client.query('UPDATE auth.identities SET registered_by_app_did = NULL WHERE id = $1', [EVENT]);
      await client.query(
        'INSERT INTO auth.identity_members (identity_did, member_did, role) VALUES ($1, $2, $3)', [EVENT, OWNER, role],
      );
      expect((await put()).status).toBe(200);
      expect((await put(request({ name: 'Renamed', createdBy: OWNER }))).status).toBe(200);
      const before = await rows();
      expect((await put(request(undefined, 'service', null))).status).toBe(401);
      sessionDid = OTHER_OWNER;
      expect((await put()).status).toBe(403);
      sessionDid = OWNER;
      await client.query('UPDATE auth.identity_members SET removed_at = NOW()');
      expect((await put()).status).toBe(403);
      expect(await rows()).toEqual(before);
    });
  });

  it.each(['member', 'agent', 'maintainer', 'cohost'])('rejects non-admin role %s', async (role) => {
    await client.query('UPDATE auth.identities SET registered_by_app_did = NULL WHERE id = $1', [EVENT]);
    for (const member of [APP, OWNER]) {
      await client.query(
        'INSERT INTO auth.identity_members (identity_did, member_did, role) VALUES ($1, $2, $3)', [EVENT, member, role],
      );
    }
    expect((await put()).status).toBe(403);
    expect(await rows()).toEqual([]);
  });

  it('does not accept ownership of another identity or caller-supplied provenance', async () => {
    await client.query('UPDATE auth.identities SET registered_by_app_did = NULL, metadata = $1 WHERE id = $2',
      [JSON.stringify({ registeredByAppDid: APP, appDid: APP, createdBy: OWNER }), EVENT]);
    await client.query(
      "INSERT INTO auth.identity_members (identity_did, member_did, role) VALUES ($1, $2, 'owner')", [OTHER_OWNER, APP],
    );
    expect((await put()).status).toBe(403);
    expect(await rows()).toEqual([]);
  });

  it('replays provenance migration twice, preserving NULL legacy and existing app provenance', async () => {
    await client.query("INSERT INTO auth.identities (id, public_key, scope) VALUES ($1, 'legacy-key', 'actor')", [OWNER]);
    await client.exec(provenanceMigration);
    await client.exec(provenanceMigration);
    expect((await client.query('SELECT id, registered_by_app_did FROM auth.identities ORDER BY id')).rows).toEqual([
      { id: OWNER, registered_by_app_did: null },
      { id: EVENT, registered_by_app_did: APP },
    ]);
  });
});
