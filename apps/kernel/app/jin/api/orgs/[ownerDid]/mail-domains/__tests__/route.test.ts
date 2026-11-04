import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/src/db/schemas/auth';

const state = vi.hoisted(() => ({
  db: undefined as unknown, auth: vi.fn(), list: vi.fn(), bindings: vi.fn(),
  provision: vi.fn(), check: vi.fn(), guidance: vi.fn(), cron: vi.fn(), poll: vi.fn(),
}));
vi.mock('@/src/db', () => ({ get db() { return state.db; }, ...schema }));
vi.mock('@imajin/auth', () => ({ requireAuth: state.auth }));
vi.mock('@/src/lib/mail/postal-domains', () => ({
  listMailDomainStates: state.list, provisionMailDomain: state.provision, checkMailDomain: state.check, pollMailDomains: state.poll,
}));
vi.mock('@/src/lib/domains/service', () => ({ listDomains: state.bindings }));
vi.mock('@/src/lib/mail/domain-guidance', () => ({ mailDomainGuidance: state.guidance }));
vi.mock('@/src/cron/auth', () => ({ requireCronAuth: state.cron }));
import { GET, POST } from '../route';
import { POST as check } from '../[domain]/check/route';
import { GET as cron } from '@/app/api/cron/mail-domain-check/route';
import { MailDomainError } from '@/src/lib/mail/postal-contract';
import { DomainError } from '@/src/lib/domains/normalize';
import { statusFixture } from '@/src/lib/mail/__tests__/postal-fixture';

let pg: PGlite;
const ownerDid = 'did:org';
const context = () => ({ params: Promise.resolve({ ownerDid, domain: 'example.org' }) });
const request = (body: unknown = { domain: 'example.org' }) => new Request('https://node.example/jin/api/orgs/did:org/mail-domains', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Acting-For': 'did:unrelated' }, body: JSON.stringify(body),
});
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.identities (id text PRIMARY KEY, scope text, subtype text, suspended_at timestamptz);
    CREATE TABLE auth.identity_members (identity_did text, member_did text, role text, removed_at timestamptz);
  `);
  state.db = drizzle(pg);
}, 30000);
afterAll(async () => { await pg.close(); });
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(async () => {
  vi.clearAllMocks();
  state.auth.mockResolvedValue({ identity: { id: 'did:human' } });
  state.list.mockResolvedValue([{ ...statusFixture(), ownerDid, error: null }]);
  state.bindings.mockResolvedValue([{ zoneOwner: ownerDid, domain: 'example.org' }]);
  state.guidance.mockResolvedValue({ records: [], error: null });
  state.provision.mockResolvedValue(statusFixture());
  state.check.mockResolvedValue(statusFixture(true));
  state.cron.mockResolvedValue(null);
  state.poll.mockResolvedValue({ checked: 1, failed: 0 });
  await pg.exec(`
    TRUNCATE auth.identities, auth.identity_members;
    INSERT INTO auth.identities VALUES ('did:human','actor','human',NULL),('did:org','business',NULL,NULL),('did:agent','actor','agent',NULL);
    INSERT INTO auth.identity_members VALUES ('did:org','did:human','owner',NULL);
  `);
});

describe('mail-domain route authorization and validation', () => {
  it.each([false, true])('personal/acting-as-org context uses the path org and current real member (actingAs=%s)', async actingAs => {
    state.auth.mockResolvedValue({ identity: { id: 'did:human', ...(actingAs ? { actingAs: ownerDid } : {}) } });
    expect((await POST(request(), context())).status).toBe(200);
    expect(state.provision).toHaveBeenCalledWith(ownerDid, 'example.org');
    expect(state.auth).toHaveBeenCalledWith(expect.any(Request), { sessionOnly: true });
    expect((await check(request(), context())).status).toBe(200);
    expect(state.check).toHaveBeenCalledWith(ownerDid, 'example.org');
    expect((await GET(request(), context())).headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('admits a current admin but not a removed or ordinary member', async () => {
    await pg.exec("UPDATE auth.identity_members SET role = 'admin'");
    expect((await POST(request(), context())).status).toBe(200);
    await pg.exec("UPDATE auth.identity_members SET role = 'member'");
    expect((await POST(request(), context())).status).toBe(403);
    await pg.exec("UPDATE auth.identity_members SET role = 'owner', removed_at = now()");
    expect((await check(request(), context())).status).toBe(403);
    expect((await GET(request(), context())).status).toBe(403);
  });
  it.each(['did:other-org', 'did:human'])('refuses mismatched acting identity %s even with cached owner role', async actingAs => {
    state.auth.mockResolvedValue({ identity: { id: 'did:human', actingAs, role: 'owner' } });
    expect((await POST(request(), context())).status).toBe(403);
    expect(state.provision).not.toHaveBeenCalled();
  });
  it('ignores X-Acting-For for org choice and refuses delegated mutations without a countersign', async () => {
    state.auth.mockResolvedValue({ identity: { id: 'did:human', actingFor: 'did:other-org' } });
    expect(await (await POST(request(), context())).json()).toMatchObject({ code: 'AGENT_APPROVAL_REQUIRED' });
    expect(await (await check(request(), context())).json()).toMatchObject({ code: 'AGENT_APPROVAL_REQUIRED' });
    expect(state.provision).not.toHaveBeenCalled();
  });
  it.each([undefined, 'did:human'])('refuses direct/delegated agents, including an agent granted owner membership (%s)', async actingFor => {
    state.auth.mockResolvedValue({ identity: { id: 'did:agent', actingFor } });
    await pg.exec("INSERT INTO auth.identity_members VALUES ('did:org','did:agent','owner',NULL)");
    expect((await POST(request(), context())).status).toBe(403);
    expect((await GET(request(), context())).status).toBe(403);
    expect((await check(request(), context())).status).toBe(403);
    expect(state.provision).not.toHaveBeenCalled();
  });
  it.each(['actor', 'business'])('refuses unavailable or suspended identities and organizations (%s)', async scope => {
    await pg.exec(`UPDATE auth.identities SET suspended_at = now() WHERE scope = '${scope}'`);
    expect((await POST(request(), context())).status).toBe(403);
  });
  it('does not grant org access to an unaffiliated human or accept an actor as org', async () => {
    await pg.exec("TRUNCATE auth.identity_members");
    expect((await POST(request(), context())).status).toBe(403);
    await pg.exec("INSERT INTO auth.identity_members VALUES ('did:org','did:human','owner',NULL); UPDATE auth.identities SET scope = 'actor' WHERE id = 'did:org'");
    expect((await POST(request(), context())).status).toBe(403);
  });
  it.each([GET, POST, check])('preserves authentication failure without querying or mutating state', async handler => {
    state.auth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await handler(request(), context())).status).toBe(401);
    expect(state.provision).not.toHaveBeenCalled();
    expect(state.check).not.toHaveBeenCalled();
    expect(state.list).not.toHaveBeenCalled();
  });
  it.each([null, {}, { domain: '' }, { domain: 2 }, { domain: 'x'.repeat(254) }, { domain: 'example.org', ownerDid: 'did:other' }])('rejects invalid provision body %j', async body => {
    expect((await POST(request(body), context())).status).toBe(400);
    expect(state.provision).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON and exposes only defined domain/client errors', async () => {
    const malformed = new Request('https://node.example', { method: 'POST', body: '{' });
    expect((await POST(malformed, context())).status).toBe(400);
    state.provision.mockRejectedValue(new MailDomainError('domain_not_verified', 403));
    expect(await (await POST(request(), context())).json()).toEqual({ error: 'domain_not_verified' });
    state.check.mockRejectedValue(new DomainError('invalid_domain', 'Invalid', 400));
    expect((await check(request(), context())).status).toBe(400);
    state.check.mockRejectedValue(new Error('private diagnostic'));
    expect(await (await check(request(), context())).json()).toEqual({ error: 'mail_domain_unavailable' });
    state.provision.mockRejectedValue(new MailDomainError('postal_unauthorized'));
    expect((await POST(request(), context())).status).toBe(503);
  });
  it('lists stored state, only currently owner-verified candidates, and hides revoked guidance', async () => {
    state.bindings.mockResolvedValue([{ zoneOwner: 'did:other', domain: 'site-only.org' }]);
    const data = await (await GET(request(), context())).json();
    expect(data.availableDomains).toEqual([]);
    expect(data.domains[0].state).toBe('disabled');
    expect(state.guidance).toHaveBeenCalledWith(expect.objectContaining({ state: 'disabled' }));
    expect(state.provision).not.toHaveBeenCalled();
    expect(state.check).not.toHaveBeenCalled();
  });
  it('sanitizes GET database failures', async () => {
    state.list.mockRejectedValue(new Error('private diagnostic'));
    expect(await (await GET(request(), context())).json()).toEqual({ error: 'mail_domain_unavailable' });
  });
});

describe('mail polling cron boundary', () => {
  it('requires cron authentication and returns only polling counts', async () => {
    state.cron.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    expect((await cron(request())).status).toBe(401);
    expect(state.poll).not.toHaveBeenCalled();
    expect(await (await cron(request())).json()).toEqual({ ok: true, checked: 1, failed: 0 });
  });
  it('sanitizes cron errors', async () => {
    state.poll.mockRejectedValue(new Error('private diagnostic'));
    expect(await (await cron(request())).json()).toEqual({ error: 'mail_domain_unavailable' });
  });
});
