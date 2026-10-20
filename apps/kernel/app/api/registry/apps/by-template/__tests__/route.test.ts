import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), caller: vi.fn(),
  database: null as ReturnType<typeof drizzle> | null,
}));
vi.mock('@imajin/auth', () => ({ requireAdmin: mocks.admin }));
vi.mock('@/src/lib/auth/app-service-caller', () => ({ resolveAppServiceCaller: mocks.caller }));
vi.mock('@/src/db', async () => ({
  registryApps: (await import('@/src/db/schemas/registry')).registryApps,
  db: new Proxy({}, {
    get: (_target, property) => {
      const db = mocks.database!;
      const value = Reflect.get(db, property);
      return typeof value === 'function' ? value.bind(db) : value;
    },
  }),
}));
import { GET } from '../route';
import { PATCH } from '../../[appId]/template/route';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
let client: PGlite;
const TEMPLATE = 'ima-jin/imajin-app-template';
const SYNC = { templateRef: 'v2.0.0', templateSyncedAt: '2026-10-17T17:00:00Z' };
const migration = readFileSync(new URL('../../../../../../../../migrations/archive/pre-kernel-baseline/0206_registry_apps_template_lineage.sql', import.meta.url), 'utf8');

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue(null);
  mocks.caller.mockResolvedValue({ appDid: 'did:cascade', scopes: ['registry:template-read'] });
  client = new PGlite();
  mocks.database = drizzle(client);
  await client.exec(`CREATE SCHEMA registry;
    CREATE SCHEMA kernel;
    CREATE TABLE kernel.app_provisions (slug text, app_did text, repo_url text);
    CREATE TABLE registry.apps (
      id text PRIMARY KEY, app_did text, source_repo text, template text, template_ref text,
      template_synced_at timestamptz, joined boolean NOT NULL DEFAULT false,
      slug text, tier text DEFAULT 'third_party',
      status text DEFAULT 'active', approved_service_scopes jsonb DEFAULT '[]', updated_at timestamptz
    );
    INSERT INTO registry.apps (id, app_did, approved_service_scopes) VALUES ('cascade', 'did:cascade', '["registry:template-read"]');
  `);
  for (const slug of ['coffee', 'dykil', 'events', 'learn', 'links', 'market', 'scorecard', 'karaoke', 'fixready']) {
    await client.query('INSERT INTO registry.apps (id, app_did, slug) VALUES ($1, $2, $3)', [`app_${slug}`, `did:${slug}`, slug]);
    await client.query('INSERT INTO kernel.app_provisions VALUES ($1, $2, $3)', [slug, `did:${slug}`, `https://github.com/ima-jin/${slug}`]);
  }
  await client.query(`INSERT INTO registry.apps (id, app_did, source_repo, template, joined) VALUES
    ('app_website', 'did:website', 'gbscontracting/website', $1, true),
    ('app_revoked', 'did:revoked', 'ima-jin/revoked', $1, true)`, [TEMPLATE]);
  await client.exec("UPDATE registry.apps SET status = 'revoked' WHERE id = 'app_revoked'");
  await client.exec(migration);
});
afterEach(async () => { await client?.close(); });

function list(template = TEMPLATE, bearer = true) {
  return GET(new NextRequest(`https://kernel.test/api/registry/apps/by-template?template=${encodeURIComponent(template)}`, {
    headers: bearer ? { Authorization: 'Bearer test-app-token' } : {},
  }));
}
function report(body: unknown = SYNC, id = 'app_coffee', bearer = true) {
  return PATCH(new NextRequest(`https://kernel.test/api/registry/apps/${id}/template`, {
    method: 'PATCH', headers: bearer ? { Authorization: 'Bearer test-app-token' } : {},
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ appId: id }) });
}

describe('template cascade inventory', () => {
  it('returns all six derived apps, cross-org repos and pending joins, without pagination or revoked/unrelated apps', async () => {
    const response = await list();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const rows = await response.json();
    expect(rows).toHaveLength(10);
    for (const slug of ['coffee', 'dykil', 'events', 'learn', 'links', 'market']) {
      expect(rows).toContainEqual({ appId: `app_${slug}`, sourceRepo: `ima-jin/${slug}`, templateRef: null, joined: true });
    }
    expect(rows).toContainEqual({ appId: 'app_website', sourceRepo: 'gbscontracting/website', templateRef: null, joined: true });
    for (const slug of ['scorecard', 'karaoke', 'fixready']) {
      expect(rows).toContainEqual({ appId: `app_${slug}`, sourceRepo: `ima-jin/${slug}`, templateRef: null, joined: false });
    }
  });
  it('permits an operator session, not an anonymous/person-only public directory read', async () => {
    expect((await list(TEMPLATE, false)).status).toBe(401);
    mocks.admin.mockResolvedValue({ actingAs: 'did:operator' });
    expect((await list(TEMPLATE, false)).status).toBe(200);
  });
  it('rejects invalid/expired/revoked callers and does not fall back to a cookie', async () => {
    mocks.caller.mockResolvedValue(null);
    mocks.admin.mockResolvedValue({ actingAs: 'did:operator' });
    expect((await list()).status).toBe(401);
  });
  it('requires both the minted scope and live operator approval', async () => {
    mocks.caller.mockResolvedValue({ appDid: 'did:cascade', scopes: [] });
    expect((await list()).status).toBe(403);
    mocks.caller.mockResolvedValue({ appDid: 'did:cascade', scopes: ['registry:template-read'] });
    await client.exec("UPDATE registry.apps SET approved_service_scopes = '[]' WHERE id = 'cascade'");
    expect((await list()).status).toBe(403);
    await client.exec("UPDATE registry.apps SET status = 'revoked', approved_service_scopes = '[\"registry:template-read\"]' WHERE id = 'cascade'");
    expect((await list()).status).toBe(403);
  });
  it('returns an empty list for an unknown template, and rejects malformed filters', async () => {
    expect(await (await list('another/template')).json()).toEqual([]);
    expect((await list('https://github.com/ima-jin/template')).status).toBe(400);
    expect((await GET(new NextRequest('https://kernel.test/api/registry/apps/by-template', { headers: { Authorization: 'Bearer test' } }))).status).toBe(400);
  });
});

describe('app-owned template sync reporting', () => {
  it('persists sync history and it is reflected in the next cascade inventory', async () => {
    mocks.caller.mockResolvedValue({ appDid: 'did:coffee', scopes: [] });
    const response = await report();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ appId: 'app_coffee', ...SYNC, templateSyncedAt: new Date(SYNC.templateSyncedAt).toISOString() });
    mocks.caller.mockResolvedValue({ appDid: 'did:cascade', scopes: ['registry:template-read'] });
    expect(await (await list()).json()).toContainEqual({ appId: 'app_coffee', sourceRepo: 'ima-jin/coffee', templateRef: SYNC.templateRef, joined: true });
  });
  it('rejects cross-app writes, unauthenticated requests, missing apps and unjoined apps', async () => {
    expect((await report()).status).toBe(403);
    expect((await report(SYNC, 'app_coffee', false)).status).toBe(401);
    expect((await report(SYNC, 'missing')).status).toBe(404);
    mocks.caller.mockResolvedValue({ appDid: 'did:scorecard', scopes: [] });
    expect((await report(SYNC, 'app_scorecard')).status).toBe(409);
    mocks.caller.mockResolvedValue(null);
    expect((await report()).status).toBe(401);
  });
  it.each([null, [], {}, { ...SYNC, sourceRepo: 'evil/repo' }, { ...SYNC, templateSyncedAt: 'bad' }])('rejects malformed reports %j', async (body) => {
    mocks.caller.mockResolvedValue({ appDid: 'did:coffee', scopes: [] });
    expect((await report(body)).status).toBe(400);
  });
  it('rejects malformed JSON', async () => {
    mocks.caller.mockResolvedValue({ appDid: 'did:coffee', scopes: [] });
    const response = await PATCH(new NextRequest('https://kernel.test/api/registry/apps/app_coffee/template', {
      method: 'PATCH', headers: { Authorization: 'Bearer test' }, body: '{',
    }), { params: Promise.resolve({ appId: 'app_coffee' }) });
    expect(response.status).toBe(400);
  });
  it('refuses a stale report when the owner changes the template during the request', async () => {
    mocks.caller.mockResolvedValue({ appDid: 'did:coffee', scopes: [] });
    const request = new NextRequest('https://kernel.test/api/registry/apps/app_coffee/template', {
      method: 'PATCH', headers: { Authorization: 'Bearer test' }, body: JSON.stringify(SYNC),
    });
    vi.spyOn(request, 'json').mockImplementation(async () => {
      await client.exec("UPDATE registry.apps SET template = 'different/template' WHERE id = 'app_coffee'");
      return SYNC;
    });
    const response = await PATCH(request, { params: Promise.resolve({ appId: 'app_coffee' }) });
    expect(response.status).toBe(409);
    expect((await client.query("SELECT template_ref FROM registry.apps WHERE id = 'app_coffee'")).rows).toEqual([{ template_ref: null }]);
  });
});
