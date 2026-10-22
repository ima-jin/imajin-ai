import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { registryApps } from '@/src/db/schemas/registry';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/registry'),
  db: new Proxy({}, { get: (_target, key) => {
    const db = holder.db as Record<string | symbol, unknown>;
    const value = db[key];
    return typeof value === 'function' ? value.bind(db) : value;
  } }),
}));
import { listRegisteredApps, registeredApp } from '../registered-apps';

const old = '2026-01-01T00:00:00.000Z';
const now = Date.parse('2026-10-21T00:00:00Z');
const row = {
  id: 'app_fixture', appDid: 'did:imajin:fixture', name: 'Legacy', tier: 'third_party', status: 'active',
  createdAt: old, ownerDid: 'did:imajin:registrar', registrar: null,
  consentAt: null, consentBy: null, consentingPrincipals: 0, liveConsents: 0,
  hasConsent: false, hasProvision: false, hasClaim: false, provisionAt: null, claimAt: null,
  lastSeen: null, endedAt: null, endedBy: null, revocationId: null,
};
describe('display-only lifecycle', () => {
  it.each(['hasConsent', 'hasProvision', 'hasClaim'] as const)('flags idle apps with %s without mutating input', key => {
    const input = { ...row, [key]: true };
    const before = structuredClone(input);
    expect(registeredApp(input, now).status).toBe('dormant');
    expect(input).toEqual(before);
  });
  it('flags first-party seeds, not unconsented DCR or legacy apps; never auto-expires', () => {
    expect(registeredApp({ ...row, tier: 'first_party' }, now)).toMatchObject({ kind: 'first-party seed', status: 'dormant' });
    expect(registeredApp({ ...row, appDid: 'did:imajin:mcp-fixture' }, now)).toMatchObject({ kind: 'MCP/DCR client', status: 'active' });
    expect(registeredApp(row, now)).toMatchObject({ kind: 'delegated app', status: 'active' });
    expect(registeredApp({ ...row, tier: 'first_party', hasProvision: true }, now).kind).toBe('delegated app');
  });
  it.each(['expired', 'revoked'] as const)('preserves terminal status %s over dormancy', status => {
    expect(registeredApp({ ...row, tier: 'first_party', status }, now).status).toBe(status);
  });
  it('uses exactly 90 days and recent activity; handles unknown historical timestamps', () => {
    const lastSeen = new Date(now - 90 * 86400_000).toISOString();
    const input = { ...row, hasConsent: true, lastSeen };
    expect(registeredApp(input, now).status).toBe('dormant');
    expect(registeredApp({ ...input, consentAt: new Date(now).toISOString() }, now).status).toBe('dormant');
    expect(registeredApp(input, now - 1).status).toBe('active');
    expect(registeredApp({ ...input, lastSeen: new Date(now).toISOString() }, now).status).toBe('active');
    expect(registeredApp({ ...input, createdAt: null, lastSeen: null }, now).status).toBe('active');
  });
  it.each(['createdAt', 'consentAt', 'provisionAt', 'claimAt'] as const)('does not flag a newly established app (%s)', key => {
    expect(registeredApp({ ...row, hasConsent: true, [key]: new Date(now).toISOString() }, now).status).toBe('active');
  });
});

let client: PGlite;
beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec(`
    CREATE SCHEMA registry; CREATE SCHEMA kernel; CREATE SCHEMA auth;
    CREATE TABLE registry.apps (id text, app_did text, name text, tier text, status text,
      created_at timestamptz, owner_did text, revoked_at timestamptz, token_audiences text[]);
    CREATE TABLE auth.attestations (id text, issuer_did text, subject_did text, type text,
      issued_at timestamptz, expires_at timestamptz, revoked_at timestamptz);
    ALTER TABLE auth.attestations ADD COLUMN context_id text, ADD COLUMN context_type text;
    CREATE TABLE kernel.app_provisions (app_did text, created_at timestamptz);
    CREATE TABLE kernel.app_signing_key_claims (app_did text, created_at timestamptz, claimed_at timestamptz);
    CREATE TABLE auth.oauth_refresh_tokens (client_id text, created_at timestamptz, last_used_at timestamptz);
    CREATE TABLE auth.app_authorization_usage (attestation_id text, last_used_at timestamptz);
    CREATE TABLE registry.system_events (did text, action text, created_at timestamptz);
    CREATE TABLE registry.app_logs (metadata jsonb, message text, created_at timestamptz);
    INSERT INTO registry.apps VALUES
      ('dcr','did:imajin:mcp-fixture','MCP','third_party','active','2026-01-01','platform',null,'{}'),
      ('legacy','did:imajin:legacy','BrokerAgent','third_party','active','2026-01-01','owner',null,'{}'),
      ('seed','did:imajin:seed','Links','first_party','active','2026-01-01','platform',null,'{links}'),
      ('expired','did:imajin:expired','Expired','third_party','expired','2026-01-01','platform','2026-09-01','{}'),
      ('revoked','did:imajin:revoked','Revoked','third_party','revoked','2026-01-01','platform','2026-09-02','{}');
    INSERT INTO auth.attestations (id, issuer_did, subject_did, type, issued_at, expires_at, revoked_at) VALUES
      ('first','principal-a','did:imajin:mcp-fixture','app.authorized','2026-01-01',null,'2026-02-01'),
      ('second','principal-b','did:imajin:mcp-fixture','app.authorized','2026-02-01',null,null),
      ('duplicate','principal-b','did:imajin:mcp-fixture','app.authorized','2026-02-02',null,null),
      ('third','principal-c','did:imajin:mcp-fixture','app.authorized','2026-02-03',null,null),
      ('stale','principal-d','did:imajin:mcp-fixture','app.authorized','2026-02-04','2026-03-01',null),
      ('reg','actual-registrar','did:imajin:legacy','registry.app.registered','2026-01-01',null,null),
      ('end1','expiry-signer','did:imajin:expired','registry.app.expired','2026-09-01',null,null),
      ('end2','operator','did:imajin:revoked','registry.app.revoked','2026-09-02',null,null);
    UPDATE auth.attestations SET context_id = 'revoked', context_type = 'registry_app' WHERE id = 'end2';
    INSERT INTO auth.oauth_refresh_tokens VALUES
      ('dcr','2026-10-10','2026-10-11'), ('dcr','2026-10-12',null);
    INSERT INTO registry.system_events VALUES
      ('did:imajin:mcp-fixture','app.token.minted','2026-10-13'),
      ('did:imajin:mcp-fixture','app.authorization.validated','2026-10-14'),
      ('did:imajin:mcp-fixture','unrelated','2026-10-15');
    INSERT INTO registry.app_logs VALUES
      ('{"aud":"links"}','minted session app token','2026-10-14'),
      ('{"appDid":"did:imajin:legacy"}','minted app service token','2026-10-15'),
      ('{"appDid":"did:imajin:legacy"}','refused app token','2026-10-16');
  `);
  holder.db = drizzle(client, { schema: { registryApps } });
}, 30_000);
afterAll(async () => { await client?.close(); });
describe('real SQL inventory', () => {
  it('returns every registry row including legacy zero-consent apps and terminal history, without writes', async () => {
    const before = await client.query('select * from registry.apps order by id');
    const apps = await listRegisteredApps();
    expect(apps).toHaveLength(5);
    expect(apps.find(app => app.id === 'legacy')).toMatchObject({
      name: 'BrokerAgent', kind: 'delegated app', consentingPrincipals: 0,
      created: { at: old, by: 'actual-registrar' },
    });
    expect(apps.find(app => app.id === 'seed')?.kind).toBe('first-party seed');
    expect(apps.find(app => app.id === 'expired')).toMatchObject({
      status: 'expired', ended: { at: '2026-09-01T00:00:00.000Z', by: 'expiry-signer' },
    });
    expect(apps.find(app => app.id === 'revoked')).toMatchObject({
      status: 'revoked', ended: { at: '2026-09-02T00:00:00.000Z', by: 'operator' },
      revocationId: 'end2',
    });
    expect(await client.query('select * from registry.apps order by id')).toEqual(before);
  });
  it('counts live consents separately from distinct principals, excluding expired and revoked grants', async () => {
    expect((await listRegisteredApps()).find(app => app.id === 'dcr')).toMatchObject({
      firstConsent: { at: old, by: 'principal-a' }, consentingPrincipals: 2, liveConsents: 3,
      lastSeen: '2026-10-14T00:00:00.000Z',
    });
  });
  it('reads refresh creation/rotation and successful mint/validate only, ignoring unrelated events', async () => {
    const apps = await listRegisteredApps();
    expect(apps.find(app => app.id === 'seed')?.lastSeen).toBe('2026-10-14T00:00:00.000Z');
    expect(apps.find(app => app.id === 'legacy')?.lastSeen).toBe('2026-10-15T00:00:00.000Z');
    await client.query('INSERT INTO auth.oauth_refresh_tokens VALUES ($1,$2,$3)', ['dcr', '2026-10-16', '2026-10-17']);
    expect((await listRegisteredApps()).find(app => app.id === 'dcr')?.lastSeen).toBe('2026-10-17T00:00:00.000Z');
  });
  it('reuses durable delegated mint/validate usage from #3009, including historical grants', async () => {
    await client.query('INSERT INTO auth.app_authorization_usage VALUES ($1,$2)', ['first', '2026-10-18']);
    expect((await listRegisteredApps()).find(app => app.id === 'dcr')?.lastSeen).toBe('2026-10-18T00:00:00.000Z');
  });
});
