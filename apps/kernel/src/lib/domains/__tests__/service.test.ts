import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import * as domains from '@/src/db/schemas/domains';
import * as auth from '@/src/db/schemas/auth';
import * as registry from '@/src/db/schemas/registry';

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  txt: vi.fn(),
  signer: vi.fn(),
  org: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@/src/db', async () => ({
  get db() { return state.db; },
  ...await import('@/src/db/schemas/domains'),
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/registry'),
}));
vi.mock('node:dns/promises', () => ({ Resolver: class { resolveTxt = state.txt; } }));
vi.mock('@/src/lib/domains/signing', () => ({
  domainSigningIdentity: state.signer, getImajinOrganization: state.org,
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: vi.fn() }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ warn: state.warn, error: vi.fn() }) }));

import {
  addDomain, verifyDomain, removeDomain, listDomains, resolveVerifiedDomain,
  resolveRoutableDomain, issueImajinDomain, recheckDomains,
} from '../service';
import { DomainError, normalizeDomain } from '../normalize';

const migration = readFileSync('migrations/0204_domain_bindings.sql', 'utf8');
const key = '1'.repeat(64);
let pg: PGlite;

async function query<T>(sql: string): Promise<T[]> {
  return (await pg.query<T>(sql)).rows;
}
async function countAttestations(): Promise<number> {
  return Number((await query<{ count: number }>('SELECT count(*) FROM auth.attestations'))[0].count);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA auth; CREATE SCHEMA registry; CREATE SCHEMA profile;
    CREATE TABLE auth.identities (id text PRIMARY KEY, public_key text, suspended_at timestamptz);
    CREATE TABLE registry.apps (app_did text PRIMARY KEY, owner_did text, status text, entry_url text, callback_url text, homepage_url text);
    CREATE TABLE registry.nodes (id text PRIMARY KEY, subdomain text);
    CREATE TABLE auth.attestations (
      id text PRIMARY KEY, issuer_did text, subject_did text, type text,
      context_id text, context_type text, payload jsonb, signature text,
      cid text, attestation_status text, issued_at timestamptz, disclosure_scope text, revoked_at timestamptz,
      nostr_sig text, author_jws text, witness_jws text, document_hash text, document_asset_id text,
      total_signers integer, delegator_did text, prev_event_ref text, delegation_grant_id text,
      supersedes text, ref text, expires_at timestamptz, lapsed_at timestamptz
    );
    CREATE TABLE profile.forest_config (group_did text PRIMARY KEY);
    CREATE FUNCTION pg_advisory_xact_lock(bigint) RETURNS void LANGUAGE sql AS 'SELECT NULL::void';
  `);
  await pg.exec(migration);
  state.db = drizzle(pg, { schema: { ...domains, ...auth, ...registry } });
}, 30000);
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  state.signer.mockResolvedValue({ issuerDid: 'did:node', privateKey: key });
  state.org.mockResolvedValue({ id: 'did:org', publicKey: authCrypto.getPublicKey(key) });
  state.txt.mockResolvedValue([['did:owner']]);
  await pg.exec(`
    TRUNCATE auth.domain_bindings, auth.attestations, auth.identities, registry.apps, registry.nodes, profile.forest_config;
    INSERT INTO auth.identities VALUES ('did:owner','pub',NULL),('did:other','other',NULL),('did:site','site',NULL),('did:org','org',NULL);
    INSERT INTO registry.apps VALUES
      ('did:app','did:site','active','https://example.com/app','https://example.com/callback',NULL),
      ('did:other-app','did:other','active',NULL,NULL,NULL);
  `);
});

describe('hostname normalization', () => {
  it.each([
    ['EXAMPLE.COM.', 'example.com'], ['bücher.de', 'xn--bcher-kva.de'], ['a-b.example.com', 'a-b.example.com'],
  ])('normalizes %s', (input, expected) => { expect(normalizeDomain(input)).toBe(expected); });
  it.each(['', 'localhost', 'https://example.com', '*.example.com', 'a..com', '-a.com', 'a-.com',
    'a.com/path', 'a.com:80', 'a@b.com', '127.0.0.1', '[::1]', 'example.123', 'a.com\n', 'a'.repeat(64) + '.com',
    'a.com..', 'a.com%00', 'a.com?x=1', 'a\\b.com'])('rejects %s', (input) => {
    expect(() => normalizeDomain(input)).toThrow(DomainError);
  });
  it('provides stable HTTP error metadata', () => {
    try { normalizeDomain('bad'); } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_domain', status: 400, name: 'DomainError' });
    }
  });
});

describe('domain binding lifecycle with actual database constraints', () => {
  it('derives separate site owner, hides pending claims, signs canonical persisted public evidence', async () => {
    const added = await addDomain({ domain: 'EXAMPLE.com', zoneOwner: 'did:owner', appDid: 'did:app' });
    expect(added).toMatchObject({ siteOwner: 'did:site', zoneOwner: 'did:owner', status: 'pending', attestation: null });
    expect(await listDomains('did:owner', true)).toEqual([]);
    expect(await resolveRoutableDomain('example.com')).toBeNull();
    state.txt.mockResolvedValue([['did:', 'owner']]);
    const verified = await verifyDomain('example.com', 'did:owner');
    expect(state.txt).toHaveBeenCalledWith('_imajin.example.com');
    expect(verified.status).toBe('verified');
    const evidence = verified.attestation!;
    expect(authCrypto.verifySync(String(evidence.signature), canonicalize({
      subject_did: evidence.subjectDid, type: evidence.type, context_id: evidence.contextId,
      context_type: evidence.contextType, payload: evidence.payload,
      issued_at: new Date(String(evidence.issuedAt)).getTime(),
    }), authCrypto.getPublicKey(key))).toBe(true);
    const persisted = await query<{ disclosure_scope: string; signature: string }>('SELECT * FROM auth.attestations');
    expect(persisted).toMatchObject([{ disclosure_scope: 'public', signature: evidence.signature }]);
    expect(await listDomains('did:site', true)).toHaveLength(1);
    expect(await resolveVerifiedDomain('example.com')).toMatchObject({ zoneOwner: 'did:owner' });
    expect(JSON.stringify(verified)).not.toContain(key);
  });

  it('accepts no-app domains and rejects missing identities/apps and suspended owners', async () => {
    expect(await addDomain({ domain: 'example.com', zoneOwner: 'did:owner' })).toMatchObject({ siteOwner: 'did:owner', appDid: null });
    await expect(addDomain({ domain: 'unknown.com', zoneOwner: 'did:none' })).rejects.toMatchObject({ code: 'identity_not_found' });
    await expect(addDomain({ domain: 'missing.com', zoneOwner: 'did:owner', appDid: 'did:none' })).rejects.toMatchObject({ code: 'app_not_found' });
    await pg.exec("UPDATE auth.identities SET suspended_at = now() WHERE id = 'did:site'");
    await expect(addDomain({ domain: 'missing.com', zoneOwner: 'did:owner', appDid: 'did:app' })).rejects.toMatchObject({ code: 'app_owner_unavailable' });
  });

  it('pending squatters never block the DNS-proven owner or overwrite verified bindings', async () => {
    await addDomain({ domain: 'example.com', zoneOwner: 'did:other' });
    await addDomain({ domain: 'example.com', zoneOwner: 'did:owner' });
    await verifyDomain('example.com', 'did:owner');
    await expect(addDomain({ domain: 'example.com', zoneOwner: 'did:other' })).rejects.toMatchObject({ code: 'domain_conflict' });
    await expect(verifyDomain('example.com', 'did:other')).rejects.toMatchObject({ code: 'domain_conflict' });
    expect(await resolveVerifiedDomain('example.com')).toMatchObject({ zoneOwner: 'did:owner' });
    await expect(pg.exec(`INSERT INTO auth.domain_bindings (id, domain, zone_owner,site_owner,method,status)
      VALUES ('race','example.com','did:third','did:third','dns-txt','verified')`)).rejects.toThrow();
  });

  it('reverification preserves original evidence and refuses app rebinding until revoked', async () => {
    await addDomain({ domain: 'example.com', zoneOwner: 'did:owner' });
    const first = await verifyDomain('example.com', 'did:owner');
    expect(await verifyDomain('example.com', 'did:owner')).toMatchObject({ attestation: first.attestation });
    expect(await addDomain({ domain: 'example.com', zoneOwner: 'did:owner' })).toMatchObject({ status: 'verified' });
    expect(await countAttestations()).toBe(1);
    await expect(addDomain({ domain: 'example.com', zoneOwner: 'did:owner', appDid: 'did:app' })).rejects.toMatchObject({ code: 'domain_conflict' });
  });

  it.each(['different DID', 'prefix did:owner suffix'])('requires exact TXT proof (%s)', async (txt) => {
    await addDomain({ domain: 'example.com', zoneOwner: 'did:owner' });
    state.txt.mockResolvedValue([[txt]]);
    await expect(verifyDomain('example.com', 'did:owner')).rejects.toMatchObject({ code: 'txt_not_found' });
    expect(await countAttestations()).toBe(0);
  });

  it.each(['ENODATA', 'ENOTFOUND'])('revokes previously verified ownership after %s', async (code) => {
    await addDomain({ domain: 'example.com', zoneOwner: 'did:owner' });
    await verifyDomain('example.com', 'did:owner');
    state.txt.mockRejectedValue({ code });
    expect(await verifyDomain('example.com', 'did:owner')).toMatchObject({ status: 'revoked', attestation: { type: 'domain.revoked' } });
    expect(await resolveVerifiedDomain('example.com')).toBeNull();
    expect(await query('SELECT id FROM auth.attestations WHERE revoked_at IS NOT NULL')).toHaveLength(1);
    await expect(verifyDomain('example.com', 'did:owner')).rejects.toMatchObject({ code: 'domain_revoked' });
    expect(await addDomain({ domain: 'example.com', zoneOwner: 'did:owner' })).toMatchObject({ status: 'pending', attestation: null });
  });

  it('fails closed on DNS failures and rolls back on signer failure', async () => {
    await addDomain({ domain: 'example.com', zoneOwner: 'did:owner' });
    state.signer.mockRejectedValueOnce(new Error('signing unavailable'));
    await expect(verifyDomain('example.com', 'did:owner')).rejects.toThrow();
    expect(await countAttestations()).toBe(0);
    expect(await listDomains('did:owner')).toMatchObject([{ status: 'pending' }]);
    await verifyDomain('example.com', 'did:owner');
    state.txt.mockRejectedValue({ code: 'ETIMEOUT' });
    expect(await verifyDomain('example.com', 'did:owner')).toMatchObject({ status: 'revoked' });
    expect(await resolveVerifiedDomain('example.com')).toBeNull();
  });

  it('commits revocation and evidence atomically; remove is idempotent and owner-bound', async () => {
    await addDomain({ domain: 'example.com', zoneOwner: 'did:owner' });
    await verifyDomain('example.com', 'did:owner');
    await expect(removeDomain('example.com', 'did:other')).rejects.toMatchObject({ code: 'domain_not_found' });
    await removeDomain('example.com', 'did:owner');
    await removeDomain('example.com', 'did:owner');
    expect(await countAttestations()).toBe(2);
    expect(await listDomains('did:owner', true)).toEqual([]);
    expect(await resolveRoutableDomain('example.com')).toBeNull();
  });

  it('rolls the attestation back when the binding write fails', async () => {
    await addDomain({ domain: 'example.com', zoneOwner: 'did:owner' });
    await pg.exec(`ALTER TABLE auth.domain_bindings ADD CONSTRAINT test_failure CHECK (status <> 'verified')`);
    await expect(verifyDomain('example.com', 'did:owner')).rejects.toThrow();
    expect(await countAttestations()).toBe(0);
    await pg.exec('ALTER TABLE auth.domain_bindings DROP CONSTRAINT test_failure');
  });

  it('rechecks due batches and revokes both lost proof and unavailable DNS', async () => {
    for (const domain of ['a.com', 'b.com', 'c.com']) {
      await addDomain({ domain, zoneOwner: 'did:owner' });
      await verifyDomain(domain, 'did:owner');
    }
    await pg.exec("UPDATE auth.domain_bindings SET checked_at = now() - interval '25 hours'");
    state.txt.mockResolvedValueOnce([]).mockRejectedValueOnce({ code: 'ESERVFAIL' }).mockResolvedValueOnce([['did:owner']]);
    expect(await recheckDomains()).toEqual({ checked: 3, revoked: 2, failed: 0 });
    expect(await listDomains('did:owner', true)).toHaveLength(1);
  });
});

describe('site owner authorization for two-party custom domains', () => {
  it('rejects a DNS owner pointing an unadvertised hostname at a victim app', async () => {
    await expect(addDomain({ domain: 'evil.example', zoneOwner: 'did:owner', appDid: 'did:app' }))
      .rejects.toMatchObject({ code: 'app_domain_not_authorized', status: 403 });
    expect(await listDomains('did:site')).toEqual([]);
    expect(await countAttestations()).toBe(0);
    expect(state.txt).not.toHaveBeenCalled();
  });

  it.each(['entry_url', 'callback_url', 'homepage_url'])('accepts distinct owners only when %s explicitly advertises the host', async (column) => {
    await pg.exec(`UPDATE registry.apps SET entry_url = NULL, callback_url = NULL, homepage_url = NULL`);
    await pg.exec(`UPDATE registry.apps SET ${column} = 'https://EXAMPLE.com./registered/path' WHERE app_did = 'did:app'`);
    await addDomain({ domain: 'example.com', zoneOwner: 'did:owner', appDid: 'did:app' });
    expect(await verifyDomain('example.com', 'did:owner')).toMatchObject({ zoneOwner: 'did:owner', siteOwner: 'did:site', status: 'verified' });
    expect(await listDomains('did:site', true)).toHaveLength(1);
  });

  it.each([
    'https://example.com.evil.test', 'https://example.com@evil.test', 'https://evil.test/example.com',
    '/example.com', 'ftp://example.com', 'https://user:pass@example.com', 'not-a-url',
  ])('never treats %s as an on-record host authorization', async (url) => {
    await pg.exec(`UPDATE registry.apps SET entry_url = NULL, callback_url = NULL, homepage_url = '${url}'`);
    await expect(addDomain({ domain: 'example.com', zoneOwner: 'did:owner', appDid: 'did:app' }))
      .rejects.toMatchObject({ code: 'app_domain_not_authorized' });
  });

  it('allows same-owner DNS app bindings without requiring registry URL changes', async () => {
    await pg.exec(`UPDATE registry.apps SET owner_did = 'did:owner', entry_url = NULL, callback_url = NULL, homepage_url = NULL`);
    await addDomain({ domain: 'new.example', zoneOwner: 'did:owner', appDid: 'did:app' });
    expect(await verifyDomain('new.example', 'did:owner')).toMatchObject({ siteOwner: 'did:owner', status: 'verified' });
  });

  it('blocks stale or forged pending app pointers at verify, before any attestation is signed', async () => {
    await pg.exec(`INSERT INTO auth.domain_bindings (id,domain,zone_owner,site_owner,app_did,method,status)
      VALUES ('forged','evil.example','did:owner','did:site','did:app','dns-txt','pending')`);
    await expect(verifyDomain('evil.example', 'did:owner')).rejects.toMatchObject({ code: 'app_domain_not_authorized' });
    expect(await countAttestations()).toBe(0);
    expect(state.signer).not.toHaveBeenCalled();
    expect(state.txt).not.toHaveBeenCalled();
  });

  it('hides revoked site authorization immediately and signs revocation on periodic recheck', async () => {
    await addDomain({ domain: 'example.com', zoneOwner: 'did:owner', appDid: 'did:app' });
    await verifyDomain('example.com', 'did:owner');
    await pg.exec(`UPDATE registry.apps SET entry_url = NULL, callback_url = NULL, homepage_url = NULL;
      UPDATE auth.domain_bindings SET checked_at = now() - interval '25 hours'`);
    expect(await resolveVerifiedDomain('example.com')).toBeNull();
    expect(await resolveRoutableDomain('example.com')).toBeNull();
    expect(await listDomains('did:site', true)).toEqual([]);
    expect(await recheckDomains()).toEqual({ checked: 1, revoked: 1, failed: 0 });
    expect(await listDomains('did:owner')).toMatchObject([{ status: 'revoked', attestation: { type: 'domain.revoked' } }]);
  });

  it('hides and revokes malicious preexisting verified app pointers without trusting DNS alone', async () => {
    await addDomain({ domain: 'example.com', zoneOwner: 'did:owner', appDid: 'did:app' });
    await verifyDomain('example.com', 'did:owner');
    await pg.exec(`UPDATE auth.domain_bindings SET domain = 'evil.example'`);
    expect(await resolveVerifiedDomain('evil.example')).toBeNull();
    expect(await listDomains('did:site', true)).toEqual([]);
    expect(await verifyDomain('evil.example', 'did:owner')).toMatchObject({ status: 'revoked' });
  });
});

describe('read-time authority and failed rechecks', () => {
  it.each(["owner_did = 'did:other'", "status = 'revoked'"])('invalidates evidence immediately when registry changes (%s)', async (update) => {
    await addDomain({ domain: 'example.com', zoneOwner: 'did:owner', appDid: 'did:app' });
    await verifyDomain('example.com', 'did:owner');
    await pg.exec(`UPDATE registry.apps SET ${update} WHERE app_did = 'did:app'`);
    expect(await resolveVerifiedDomain('example.com')).toBeNull();
    expect(await listDomains('did:site', true)).toEqual([]);
    expect(await verifyDomain('example.com', 'did:owner')).toMatchObject({ status: 'revoked' });
  });

  it('expires DNS evidence at read time if cron or signing is unavailable', async () => {
    await addDomain({ domain: 'example.com', zoneOwner: 'did:owner' });
    await verifyDomain('example.com', 'did:owner');
    await pg.exec("UPDATE auth.domain_bindings SET checked_at = now() - interval '49 hours'");
    expect(await resolveVerifiedDomain('example.com')).toBeNull();
    expect(await listDomains('did:owner', true)).toEqual([]);
    state.txt.mockResolvedValue([]);
    state.signer.mockRejectedValueOnce(new Error('unavailable'));
    expect(await recheckDomains()).toEqual({ checked: 0, revoked: 0, failed: 1 });
    expect(state.warn).toHaveBeenCalled();
  });

  it('handles absent claims and pending lookup failures without creating evidence', async () => {
    await expect(verifyDomain('missing.com', 'did:owner')).rejects.toMatchObject({ code: 'domain_not_found' });
    await addDomain({ domain: 'example.com', zoneOwner: 'did:owner' });
    state.txt.mockRejectedValue({ code: 'ESERVFAIL' });
    await expect(verifyDomain('example.com', 'did:owner')).rejects.toMatchObject({ code: 'dns_unavailable' });
    expect(await countAttestations()).toBe(0);
  });
});

describe('organization issuance and legacy compatibility', () => {
  it('issues with actual org issuer and registry app owner, idempotently without DNS', async () => {
    state.signer.mockResolvedValue({ issuerDid: 'did:org', privateKey: key });
    const issued = await issueImajinDomain({ domain: 'gbs.imajin.ai', appDid: 'did:app' });
    expect(issued).toMatchObject({ zoneOwner: 'did:org', siteOwner: 'did:site', method: 'imajin-issued',
      attestation: { issuerDid: 'did:org', subjectDid: 'did:site', payload: { did: 'did:site' } }, status: 'verified' });
    expect(await issueImajinDomain({ domain: 'gbs.imajin.ai', appDid: 'did:app' })).toEqual(issued);
    expect(state.txt).not.toHaveBeenCalled();
    await expect(issueImajinDomain({ domain: 'gbs.imajin.ai', appDid: 'did:other-app' })).rejects.toMatchObject({ code: 'domain_conflict' });
    await expect(verifyDomain('gbs.imajin.ai', 'did:org')).rejects.toMatchObject({ code: 'invalid_method' });
    await removeDomain('gbs.imajin.ai', 'did:org');
    expect(await resolveVerifiedDomain('gbs.imajin.ai')).toBeNull();
  });

  it('fails issuance closed for missing org, mismatched signer, invalid domains and reserved claims', async () => {
    await expect(addDomain({ domain: 'gbs.imajin.ai', zoneOwner: 'did:owner' })).rejects.toMatchObject({ code: 'reserved_domain' });
    await expect(issueImajinDomain({ domain: 'elsewhere.com', appDid: 'did:app' })).rejects.toMatchObject({ code: 'invalid_domain' });
    await expect(issueImajinDomain({ domain: 'a.b.imajin.ai', appDid: 'did:app' })).rejects.toMatchObject({ code: 'invalid_domain' });
    state.org.mockRejectedValueOnce(new DomainError('issuer_unavailable', 'Unavailable', 503));
    await expect(issueImajinDomain({ domain: 'gbs.imajin.ai', appDid: 'did:app' })).rejects.toMatchObject({ status: 503 });
    await expect(issueImajinDomain({ domain: 'gbs.imajin.ai', appDid: 'did:app' })).rejects.toMatchObject({ code: 'issuer_unavailable' });
    expect(await listDomains('did:org')).toEqual([]);
  });

  it('protects infrastructure labels and already registered node hostnames', async () => {
    await expect(issueImajinDomain({ domain: 'auth.imajin.ai', appDid: 'did:app' })).rejects.toMatchObject({ code: 'reserved_domain' });
    await pg.exec("INSERT INTO registry.nodes VALUES ('did:node','my-node.imajin.ai')");
    await expect(issueImajinDomain({ domain: 'my-node.imajin.ai', appDid: 'did:app' })).rejects.toMatchObject({ code: 'reserved_domain' });
  });

  it('preserves legacy routing until a different owner proves DNS control', async () => {
    await pg.exec(`INSERT INTO auth.domain_bindings (id,domain,zone_owner,site_owner,method,status)
      VALUES ('legacy','example.com','did:other','did:other','legacy','legacy')`);
    await addDomain({ domain: 'example.com', zoneOwner: 'did:owner' });
    expect(await resolveRoutableDomain('example.com')).toMatchObject({ siteOwner: 'did:other', status: 'legacy' });
    await verifyDomain('example.com', 'did:owner');
    expect(await resolveRoutableDomain('example.com')).toMatchObject({ siteOwner: 'did:owner', status: 'verified' });
    expect(await listDomains('did:other')).toMatchObject([{ status: 'revoked', attestation: null }]);
  });

  it('preserves a same-owner legacy route on add and upgrades it only with DNS proof', async () => {
    await pg.exec(`INSERT INTO auth.domain_bindings (id,domain,zone_owner,site_owner,method,status)
      VALUES ('legacy','example.com','did:owner','did:owner','legacy','legacy')`);
    expect(await addDomain({ domain: 'example.com', zoneOwner: 'did:owner' })).toMatchObject({ status: 'legacy' });
    expect(await resolveRoutableDomain('example.com')).toMatchObject({ status: 'legacy' });
    expect(await verifyDomain('example.com', 'did:owner')).toMatchObject({ status: 'verified', method: 'dns-txt' });
  });

  it('migration is idempotent both without and with deployed custom_domain; legacy evidence is never fabricated', async () => {
    await pg.exec(migration);
    await pg.exec(`ALTER TABLE profile.forest_config ADD COLUMN custom_domain text;
      INSERT INTO profile.forest_config VALUES ('did:legacy', 'LEGACY.EXAMPLE.COM.')`);
    await pg.exec(migration);
    await pg.exec(migration);
    expect(await resolveRoutableDomain('legacy.example.com')).toMatchObject({
      method: 'legacy', status: 'legacy', siteOwner: 'did:legacy', appDid: null, attestation: null,
    });
    expect(state.warn).toHaveBeenCalled();
    expect(await resolveVerifiedDomain('legacy.example.com')).toBeNull();
    expect(await listDomains('did:legacy', true)).toEqual([]);
    expect(await countAttestations()).toBe(0);
  });
});
