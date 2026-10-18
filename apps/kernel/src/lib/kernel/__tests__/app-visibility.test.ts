import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';

const h = vi.hoisted(() => ({ database: undefined as PgliteDatabase | undefined }));
vi.mock('@/src/db', async () => {
  const schema = await import('@/src/db/schemas/auth');
  return {
    identities: schema.identities,
    identityMembers: schema.identityMembers,
    db: { select: (...args: Parameters<PgliteDatabase['select']>) => h.database!.select(...args) },
  };
});
import { canAccessAppListing, canDiscoverApp, resolveAppOwnerDids } from '../app-visibility';

vi.setConfig({ testTimeout: 30_000 });
let client: PGlite | undefined;
afterEach(async () => { await client?.close(); client = undefined; });

describe('live owning identity membership', () => {
  it('follows accepted membership and departure without treating an agent delegation as membership', async () => {
    client = new PGlite();
    h.database = drizzle(client);
    await client.exec(`
      CREATE SCHEMA auth;
      CREATE TABLE auth.identities (
      registered_by_app_did text,id text PRIMARY KEY, scope text);
      CREATE TABLE auth.identity_members (identity_did text, member_did text, removed_at timestamptz);
      INSERT INTO auth.identities VALUES ('business','business'), ('person','actor'), ('other-person','actor');
    `);
    const app = { visibility: 'private', ownerDid: 'business' };
    expect(canDiscoverApp(app, await resolveAppOwnerDids('person'))).toBe(false);
    // Accepting an identity invite creates this active membership; no profile
    // feature_toggles or app.authorized record is needed to inherit the app.
    await client.exec("INSERT INTO auth.identity_members VALUES ('business','person',NULL)");
    expect(canDiscoverApp(app, await resolveAppOwnerDids('person'))).toBe(true);
    await client.exec("UPDATE auth.identity_members SET removed_at = NOW() WHERE identity_did = 'business'");
    expect(canAccessAppListing(app, await resolveAppOwnerDids('person'))).toBe(false);
    await client.exec("INSERT INTO auth.identity_members VALUES ('other-person','person',NULL)");
    expect(canAccessAppListing({ visibility: 'private', ownerDid: 'other-person' }, await resolveAppOwnerDids('person'))).toBe(false);
    expect(canAccessAppListing({ visibility: 'private', ownerDid: 'person' }, await resolveAppOwnerDids('person'))).toBe(true);
  });
});

describe('listing visibility matrix', () => {
  it.each([
    ['public', true, true], ['unlisted', false, true], ['private', false, false],
    ['internal', false, false], ['invalid', false, false],
  ])('%s has independent discovery and direct-link behavior', (visibility, discover, access) => {
    const app = { visibility, ownerDid: 'owner' };
    expect(canDiscoverApp(app, new Set(['viewer']))).toBe(discover);
    expect(canAccessAppListing(app, new Set(['viewer']))).toBe(access);
  });
  it('fails closed for private apps without an owner and never gives owners internal tiles', () => {
    expect(canAccessAppListing({ visibility: 'private' }, new Set())).toBe(false);
    expect(canDiscoverApp({ visibility: 'internal', ownerDid: 'owner' }, new Set(['owner']))).toBe(false);
  });
});
