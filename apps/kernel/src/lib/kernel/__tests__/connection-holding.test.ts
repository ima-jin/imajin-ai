import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/connectors'),
  get db() { return h.db; },
}));
import { orgConnectionMemberGrants } from '@/src/db';
import {
  connectionProviderNames, connectionStorageProvider, connectorPurpose, connectorVendor,
  isGrantedTo, isHeldBy, isUpstreamConnection, readConnectionGrant,
} from '../connection-holding';

let client: PGlite;
let database: ReturnType<typeof drizzle>;
const holder = 'did:imajin:family';
const member = 'did:imajin:member';
const row = {
  id: 'held-connection', ownerDid: holder, status: 'active', revokedAt: null, expiresAt: null,
};

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client);
  h.db = database;
  await client.exec(`CREATE SCHEMA kernel;
    CREATE TABLE kernel.org_connection_member_grants (
      id text PRIMARY KEY, org_did text NOT NULL, member_did text NOT NULL,
      connection_id text NOT NULL, provider text NOT NULL, granted_by_did text NOT NULL,
      granted_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
      revoked_by_did text, revocation_reason text
    );`);
});
beforeEach(async () => { await client.exec('TRUNCATE kernel.org_connection_member_grants'); });
afterAll(async () => { await client.close(); });

async function grant(overrides: Partial<typeof orgConnectionMemberGrants.$inferInsert> = {}) {
  await database.insert(orgConnectionMemberGrants).values({
    id: 'grant', orgDid: holder, memberDid: member, connectionId: row.id, provider: 'anthropic',
    grantedByDid: holder, ...overrides,
  });
}

describe('connection holder and live use authority', () => {
  it.each(['did:imajin:org', 'did:imajin:family', 'did:imajin:event', 'did:imajin:agent'])(
    'recognizes %s by ownerDid alone, without scope or provider encoding', did => {
      expect(isHeldBy({ ownerDid: did }, did)).toBe(true);
      expect(isHeldBy({ ownerDid: did }, member)).toBe(false);
    },
  );

  it.each(['did:imajin:family', 'did:imajin:delegating-agent'])(
    'lets a non-org holder %s grant live use and refuses immediately after revocation', async ownerDid => {
      const connection = { ...row, ownerDid };
      expect(await isGrantedTo(connection, member)).toBe(false);
      await grant({ orgDid: ownerDid });
      expect(await isGrantedTo(connection, member)).toBe(true);
      expect(await readConnectionGrant(connection, member)).toMatchObject({ id: 'grant', connectionId: row.id });
      await database.update(orgConnectionMemberGrants).set({ revokedAt: new Date() })
        .where(eq(orgConnectionMemberGrants.id, 'grant'));
      expect(await isGrantedTo(connection, member)).toBe(false);
    },
  );

  it('treats the holder as held, never granted, even if a self-grant exists', async () => {
    await grant({ memberDid: holder });
    expect(isHeldBy(row, holder)).toBe(true);
    expect(await isGrantedTo(row, holder)).toBe(false);
  });

  it.each([
    { orgDid: 'did:imajin:other-holder' }, { memberDid: 'did:imajin:outsider' },
    { connectionId: 'personal-connection' }, { revokedAt: new Date(0) },
  ])('refuses a grant for the wrong holder/caller/connection or revoked history: %j', async mismatch => {
    await grant(mismatch);
    expect(await isGrantedTo(row, member)).toBe(false);
  });

  it.each([
    { status: 'revoked' }, { status: 'removed' }, { revokedAt: new Date(0) },
    { expiresAt: new Date(0) },
  ])('refuses a non-live connector even with an unrevoked grant: %j', async changes => {
    await grant();
    expect(await isGrantedTo({ ...row, ...changes }, member)).toBe(false);
  });

  it('uses connection identity, not the grant provider label, and supports an injected transaction', async () => {
    await grant({ provider: 'legacy-label' });
    expect(await isGrantedTo({ ...row, expiresAt: new Date(Date.now() + 60_000) }, member, database)).toBe(true);
  });
});

describe('temporary legacy compatibility boundary', () => {
  it.each([
    ['anthropic', 'anthropic', 'inference'],
    ['org-held-anthropic', 'anthropic', 'inference'],
    ['org-held-warp', 'warp', 'inference'],
    ['anthropic-billing', 'anthropic', 'billing'],
    ['openai-billing', 'openai', 'billing'],
    ['org-held-openai-billing', 'openai', 'billing'],
  ] as const)('reads %s as vendor %s and purpose %s', (provider, vendor, purpose) => {
    expect(connectorVendor({ provider })).toBe(vendor);
    expect(connectorPurpose({ provider })).toBe(purpose);
    expect(connectionProviderNames(vendor, purpose)).toContain(provider);
  });

  it('prefers the purpose column when present and never infers custody from names', () => {
    expect(connectorPurpose({ provider: 'anthropic-billing', purpose: 'inference' })).toBe('inference');
    expect(connectorPurpose({ provider: 'openai', purpose: 'billing' })).toBe('billing');
    expect(isUpstreamConnection({ provider: 'vendor', upstreamBinding: 'binding-digest' })).toBe(true);
    expect(isUpstreamConnection({ provider: 'app-upstream:did:imajin:app:catalog' })).toBe(true);
    expect(isUpstreamConnection({ provider: 'warp' })).toBe(false);
    expect(connectionStorageProvider('openai', 'billing')).toBe('openai-billing');
    expect(connectionStorageProvider('warp', 'inference')).toBe('warp');
  });
});
