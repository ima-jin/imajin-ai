import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as vaultSchema from '@/src/db/schemas/vault';
const state = vi.hoisted(() => ({ db: undefined as unknown, fetch: vi.fn(), resolve: vi.fn() }));
vi.mock('@/src/db', async () => ({
  get db() { return state.db; }, ...await import('@/src/db/schemas/vault'),
}));
vi.mock('@/src/lib/vault', () => ({ fetchGrantSecret: state.fetch }));
vi.mock('@/src/lib/domains/service', () => ({ resolveVerifiedDomain: state.resolve }));
import { resolveDomainCredential } from '../domain-credential';
import { fetchPurposeCredential } from '../purpose-credential';

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE SCHEMA kernel; CREATE TABLE kernel.vault_delegation_grants (
    id text PRIMARY KEY, subject text, granted_to text, purpose text, status text,
    expires_at timestamptz, one_time boolean, consumed_at timestamptz
  )`);
  state.db = drizzle(pg, { schema: vaultSchema });
}, 30000);
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  state.resolve.mockResolvedValue({ zoneOwner: 'did:zone', siteOwner: 'did:site' });
  state.fetch.mockResolvedValue({
    status: 'ok', value: 'scoped credential',
    grant: { subject: 'did:zone', grantedTo: 'did:edge', purpose: 'dns.cloudflare' },
  });
  await pg.exec(`TRUNCATE kernel.vault_delegation_grants;
    INSERT INTO kernel.vault_delegation_grants VALUES
      ('correct', 'did:zone', 'did:edge', 'dns.cloudflare', 'active', NULL, false, NULL)`);
});

describe('verified zone owner vault credential resolution', () => {
  it('follows verified binding to zone owner, never site owner or node env, using existing grant fetch', async () => {
    expect(await resolveDomainCredential('example.com', 'did:edge', 'dns.cloudflare')).toBe('scoped credential');
    expect(state.fetch).toHaveBeenCalledWith({ grantId: 'correct', granteeDid: 'did:edge' });
  });
  it('never fetches for unverified/revoked/legacy binding or wrong purpose/grantee', async () => {
    state.resolve.mockResolvedValueOnce(null);
    await expect(resolveDomainCredential('example.com', 'did:edge', 'dns.cloudflare')).rejects.toMatchObject({ code: 'domain_not_verified' });
    await expect(resolveDomainCredential('example.com', 'did:wrong', 'dns.cloudflare')).rejects.toMatchObject({ code: 'credential_unavailable' });
    await expect(resolveDomainCredential('example.com', 'did:edge', 'wrong')).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it.each([
    "subject = 'did:site'", "status = 'revoked'", "expires_at = now() - interval '1 second'",
    "one_time = true, consumed_at = now()",
  ])('refuses non-active subject-bound grants (%s)', async (update) => {
    await pg.exec('UPDATE kernel.vault_delegation_grants SET ' + update);
    await expect(resolveDomainCredential('example.com', 'did:edge', 'dns.cloudflare')).rejects.toMatchObject({ status: 403 });
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it('rejects ambiguity instead of selecting an arbitrary secret', async () => {
    await pg.exec(`INSERT INTO kernel.vault_delegation_grants SELECT 'second', subject, granted_to, purpose, status, expires_at, one_time, consumed_at FROM kernel.vault_delegation_grants`);
    await expect(resolveDomainCredential('example.com', 'did:edge', 'dns.cloudflare')).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it('rechecks grant fetch lifecycle and subject/purpose after selection', async () => {
    state.fetch.mockResolvedValueOnce({ status: 'revoked' }).mockResolvedValueOnce({
      status: 'ok', value: 'must not return', grant: { subject: 'did:wrong', purpose: 'dns.cloudflare', grantedTo: 'did:edge' },
    });
    await expect(resolveDomainCredential('example.com', 'did:edge', 'dns.cloudflare')).rejects.toMatchObject({ code: 'credential_unavailable' });
    await expect(resolveDomainCredential('example.com', 'did:edge', 'dns.cloudflare')).rejects.toMatchObject({ code: 'credential_unavailable' });
  });
  it('rejects missing scope without fetching or falling back', async () => {
    await expect(fetchPurposeCredential('', 'did:edge', 'dns.cloudflare')).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(state.fetch).not.toHaveBeenCalled();
  });
});
