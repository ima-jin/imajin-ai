import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ pg: null as unknown as import('@electric-sql/pglite').PGlite }));
vi.mock('@/src/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const auth = await import('@/src/db/schemas/auth');
  const profile = await import('@/src/db/schemas/profile');
  const pay = await import('@/src/db/schemas/pay');
  h.pg = new PGlite();
  return {
    db: drizzle(h.pg), identities: auth.identities, channelLinks: auth.channelLinks,
    profiles: profile.profiles, transactions: pay.transactions, registryApps: {},
  };
});
vi.mock('@/src/lib/auth/jwt', () => ({ verifyAppServiceToken: vi.fn(), verifyAppToken: vi.fn() }));
import { backfillContact } from '../backfill-contact';
import { relatedContactDids } from '../app-contact-auth';

const PERSON = 'did:imajin:buyer';
const APP = 'did:imajin:events';
const OTHER = 'did:imajin:other';
const READ = 'profile:email:read';
const WRITE = 'profile:contact:backfill';
const EMAIL = 'buyer@example.com';

beforeAll(async () => {
  await h.pg.exec(`
    CREATE SCHEMA auth; CREATE SCHEMA profile; CREATE SCHEMA pay;
    CREATE TABLE auth.identities (
      registered_by_app_did text,id text PRIMARY KEY, contact_email text);
    CREATE TABLE profile.profiles (did text PRIMARY KEY, contact_email text);
    CREATE TABLE pay.transactions (app_did text, from_did text, status text);
    CREATE TABLE auth.channel_links (
      channel text, did text, app_did text, status text, scopes jsonb
    );
  `);
}, 30_000);
afterAll(() => h.pg.close());
beforeEach(async () => {
  await h.pg.exec(`TRUNCATE auth.identities, profile.profiles, pay.transactions, auth.channel_links`);
  await h.pg.query('INSERT INTO auth.identities VALUES ($1, NULL)', [PERSON]);
  await h.pg.query('INSERT INTO profile.profiles VALUES ($1, NULL)', [PERSON]);
});

async function addresses() {
  const identity = await h.pg.query('SELECT contact_email FROM auth.identities WHERE id = $1', [PERSON]);
  const profile = await h.pg.query('SELECT contact_email FROM profile.profiles WHERE did = $1', [PERSON]);
  return [identity.rows[0], profile.rows[0]];
}

describe('contact contract against real Postgres SQL', () => {
  it('fills both NULL columns once and preserves them on conflicting retries', async () => {
    expect(await backfillContact(PERSON, EMAIL)).toMatchObject({ backfilled: true });
    expect(await backfillContact(PERSON, 'different@example.com')).toMatchObject({ backfilled: false });
    expect(await addresses()).toEqual([{ contact_email: EMAIL }, { contact_email: EMAIL }]);
  });

  it('fills a missing profile using existing identity email, never a conflicting posted value', async () => {
    await h.pg.query('UPDATE auth.identities SET contact_email = $1 WHERE id = $2', [EMAIL, PERSON]);
    expect(await backfillContact(PERSON, 'different@example.com')).toMatchObject({ backfilled: true });
    expect(await addresses()).toEqual([{ contact_email: EMAIL }, { contact_email: EMAIL }]);
  });

  it('does not overwrite an existing profile address while filling the identity', async () => {
    await h.pg.query('UPDATE profile.profiles SET contact_email = $1 WHERE did = $2', ['profile@example.com', PERSON]);
    await backfillContact(PERSON, EMAIL);
    expect(await addresses()).toEqual([{ contact_email: EMAIL }, { contact_email: 'profile@example.com' }]);
  });

  it('does not create a missing profile or update a profile for a missing identity', async () => {
    await h.pg.exec('TRUNCATE profile.profiles');
    expect(await backfillContact(PERSON, EMAIL)).toMatchObject({ backfilled: true });
    expect((await h.pg.query('SELECT * FROM profile.profiles')).rows).toEqual([]);
    expect(await backfillContact(OTHER, EMAIL)).toBeNull();
  });

  it('serializes competing backfills so exactly one fills the NULL columns', async () => {
    const results = await Promise.all([backfillContact(PERSON, EMAIL), backfillContact(PERSON, 'second@example.com')]);
    expect(results.filter((result) => result?.backfilled)).toHaveLength(1);
    const rows = await addresses();
    expect(rows[0]).toEqual(rows[1]);
  });

  it('rolls the identity back if the profile write fails', async () => {
    await h.pg.exec(`ALTER TABLE profile.profiles ADD CONSTRAINT reject_contact CHECK (contact_email IS NULL)`);
    try {
      await expect(backfillContact(PERSON, EMAIL)).rejects.toThrow();
      expect(await addresses()).toEqual([{ contact_email: null }, { contact_email: null }]);
    } finally {
      await h.pg.exec('ALTER TABLE profile.profiles DROP CONSTRAINT reject_contact');
    }
  });

  it('allows only the completed payment payer bound to this exact app', async () => {
    await h.pg.query('INSERT INTO pay.transactions VALUES ($1, $2, $3)', [APP, PERSON, 'completed']);
    expect(await relatedContactDids(APP, [PERSON, OTHER], READ)).toEqual([PERSON]);
    expect(await relatedContactDids(OTHER, [PERSON], READ)).toEqual([]);
  });

  it.each(['pending', 'failed', 'refunded'])('does not use a %s payment as relationship proof', async (status) => {
    await h.pg.query('INSERT INTO pay.transactions VALUES ($1, $2, $3)', [APP, PERSON, status]);
    expect(await relatedContactDids(APP, [PERSON], READ)).toEqual([]);
  });

  it('does not use unbound or anonymous payments', async () => {
    await h.pg.query('INSERT INTO pay.transactions VALUES ($1, NULL, $2), (NULL, $3, $2)', [APP, 'completed', PERSON]);
    expect(await relatedContactDids(APP, [PERSON], READ)).toEqual([]);
  });

  it('enforces exact active grant app/person/scope and immediately respects revocation', async () => {
    await h.pg.query('INSERT INTO auth.channel_links VALUES ($1, $2, $3, $4, $5)', ['app', PERSON, APP, 'active', JSON.stringify([READ])]);
    expect(await relatedContactDids(APP, [PERSON, OTHER], READ)).toEqual([PERSON]);
    expect(await relatedContactDids(OTHER, [PERSON], READ)).toEqual([]);
    expect(await relatedContactDids(APP, [PERSON], WRITE)).toEqual([]);
    await h.pg.exec(`UPDATE auth.channel_links SET status = 'revoked'`);
    expect(await relatedContactDids(APP, [PERSON], READ)).toEqual([]);
  });
});
