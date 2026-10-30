import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { NextRequest } from 'next/server';
import { parse } from 'yaml';

const state = vi.hoisted(() => ({
  db: undefined as unknown, cards: vi.fn(), binding: vi.fn(), session: vi.fn(), app: vi.fn(),
}));
vi.mock('@/src/db', async () => ({
  get db() { return state.db; }, ...await import('@/src/db/schemas/auth'),
}));
vi.mock('@/src/lib/vault/import', () => ({ listImportedKeyCards: state.cards }));
vi.mock('@/src/lib/vault', () => ({ fetchGrantSecret: vi.fn() }));
vi.mock('@/src/lib/domains/service', () => ({ resolveVerifiedDomain: state.binding }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: () => ({ senderDid: 'did:imajin:node' }) }));
vi.mock('@/src/lib/vault/import-authority', () => ({ isImportHuman: vi.fn(), controlsImportOwner: vi.fn() }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@/src/lib/auth/attest-delegation', () => ({ validateAttestDelegationCapabilities: vi.fn() }));
vi.mock('@imajin/auth', async original => ({
  ...await original<typeof import('@imajin/auth')>(), requireAuth: state.session, requireAppAuth: state.app,
}));
import { GET, OPTIONS, dynamic } from '@/app/cloudflare/api/grants/route';
import { listCloudflareZoneGrants } from '../zone-grants';

const AGENT = 'did:imajin:agent';
const OWNER = 'did:imajin:owner';
const ZONE = 'a'.repeat(32);
const AUDIENCE = { type: 'dids', values: [`did:imajin:cloudflare-${ZONE}`] };
const spec = parse(readFileSync('apps/kernel/api-spec/cloudflare.yaml', 'utf8'));
let pg: PGlite;

function card() {
  return {
    ownerDid: OWNER, consumerDid: 'did:imajin:node', status: 'active', purpose: `dns.cloudflare:${ZONE}`,
    cloudflare: { zoneId: ZONE, domain: 'example.com' },
    // Extra metadata must not cross the explicit response projection.
    field: 'private-field-reference', fingerprint: 'private-fingerprint', timeline: [],
  };
}
const request = (query = '', headers?: HeadersInit) =>
  new NextRequest(`https://kernel.test/cloudflare/api/grants${query}`, { headers });

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  state.db = drizzle(pg);
  await pg.exec('CREATE SCHEMA auth;');
  await pg.exec(readFileSync('migrations/archive/pre-kernel-baseline/0099_delegation_grants.sql', 'utf8'));
  await pg.query(`INSERT INTO auth.delegation_grants(id,agent_did,delegator_did,audience,expires_at)
    VALUES ('own',$1,$2,$3,now() + interval '1 day'),
      ('other','did:imajin:other',$2,$3,now() + interval '1 day')`, [AGENT, OWNER, AUDIENCE]);
  await pg.exec(`INSERT INTO auth.delegation_grant_capabilities(id,grant_id,capability,status) VALUES
    ('dns','own','cloudflare:dns','active'),('cache','own','cloudflare:cache','active'),
    ('read','own','cloudflare:read','revoked'),('unrelated','own','intros:propose','active'),
    ('other','other','cloudflare:read','active');`);
}, 30_000);
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  await pg.exec('BEGIN');
  vi.clearAllMocks();
  state.cards.mockResolvedValue([card()]);
  state.binding.mockResolvedValue({ domain: 'example.com', zoneOwner: OWNER });
  state.session.mockResolvedValue({ identity: { id: AGENT, actingFor: OWNER, actingAs: OWNER } });
  state.app.mockResolvedValue({ error: 'Not an app token', status: 401, notAppToken: true });
});
afterEach(async () => { await pg.exec('ROLLBACK'); });

describe('grantee Cloudflare zone grant discovery', () => {
  it('returns only the actual grantee’s active capabilities and exact metadata contract', async () => {
    const result = await GET(request(`?agentDid=did:imajin:other&ownerDid=${OWNER}`, { 'X-Acting-For': OWNER }));
    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(dynamic).toBe('force-dynamic');
    const body = await result.json();
    expect(body.grants).toEqual([{
      grantId: 'own', agentDid: AGENT, delegatorDid: OWNER, audience: AUDIENCE,
      zoneId: ZONE, domain: 'example.com', capabilities: ['cloudflare:cache', 'cloudflare:dns'],
      issuedAt: expect.any(String), expiresAt: expect.any(String),
    }]);
    const schema = spec.components.schemas.ZoneGrant;
    expect(Object.keys(body.grants[0]).sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.additionalProperties).toBe(false);
    expect(state.cards).toHaveBeenCalledWith([OWNER]);
    expect(state.binding).toHaveBeenCalledWith('example.com');
    expect(body.grants[0]).not.toHaveProperty('field');
    expect(body.grants[0]).not.toHaveProperty('fingerprint');
  });

  it.each(['revoked', 'expired', 'boundary', 'capability-revoked'])('excludes %s authority on the very next read', async change => {
    expect(await listCloudflareZoneGrants(AGENT)).toHaveLength(1);
    if (change === 'revoked') await pg.exec("UPDATE auth.delegation_grants SET status='revoked' WHERE id='own'");
    if (change === 'expired') await pg.exec("UPDATE auth.delegation_grants SET expires_at=now() - interval '1 second' WHERE id='own'");
    if (change === 'boundary') await pg.exec("UPDATE auth.delegation_grants SET expires_at=now() WHERE id='own'");
    if (change === 'capability-revoked') await pg.exec("UPDATE auth.delegation_grant_capabilities SET status='revoked' WHERE grant_id='own'");
    expect(await listCloudflareZoneGrants(AGENT)).toEqual([]);
  });

  it.each([
    null, { type: 'all' }, { type: 'dids', values: [] },
    { type: 'dids', values: ['did:imajin:unrelated'] },
    { type: 'dids', values: ['did:imajin:cloudflare-*'] },
    { type: 'dids', values: [...AUDIENCE.values, `did:imajin:cloudflare-${'b'.repeat(32)}`] },
  ])('excludes non-exact zone audience %j', async audience => {
    // NULL cannot be stored in the NOT NULL audience column; JSON null can.
    await pg.query("UPDATE auth.delegation_grants SET audience=$1::jsonb WHERE id='own'", [JSON.stringify(audience)]);
    expect(await listCloudflareZoneGrants(AGENT)).toEqual([]);
    expect(state.cards).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'expired', 'unavailable'])('excludes %s credential metadata', async status => {
    state.cards.mockResolvedValue([{ ...card(), status }]);
    expect(await listCloudflareZoneGrants(AGENT)).toEqual([]);
  });
  it.each([
    [], [card(), card()], [{ ...card(), ownerDid: 'did:imajin:other' }],
    [{ ...card(), consumerDid: AGENT }], [{ ...card(), purpose: 'unrelated' }],
    [{ ...card(), cloudflare: undefined }],
    [{ ...card(), cloudflare: { zoneId: 'b'.repeat(32), domain: 'example.com' } }],
    [{ ...card(), cloudflare: { zoneId: ZONE, domain: 'EXAMPLE.COM' } }],
  ].map(cards => ({ cards })))('excludes missing, ambiguous or mismatched import metadata %#', async ({ cards }) => {
    state.cards.mockResolvedValue(cards);
    expect(await listCloudflareZoneGrants(AGENT)).toEqual([]);
  });
  it.each([null, { domain: 'example.com', zoneOwner: 'did:imajin:other' }, { domain: 'sub.example.com', zoneOwner: OWNER }])(
    'excludes absent/stale ownership or a non-canonical binding %j', async binding => {
      state.binding.mockResolvedValue(binding);
      expect(await listCloudflareZoneGrants(AGENT)).toEqual([]);
    },
  );
  it('does not turn a delegator identity into grantee authority or list another principal', async () => {
    expect(await listCloudflareZoneGrants(OWNER)).toEqual([]);
    expect(await listCloudflareZoneGrants('did:imajin:stranger')).toEqual([]);
    expect(state.cards).not.toHaveBeenCalled();
  });
  it('uses appDid rather than the app token’s userDid, without requiring cloudflare:read', async () => {
    state.app.mockResolvedValue({ appAuth: { appDid: AGENT, userDid: 'did:imajin:other', scopes: [] } });
    const result = await GET(request('', { 'X-App-DID': AGENT, 'X-App-Authorization': 'fixture-reference' }));
    expect((await result.json()).grants.map((grant: { grantId: string }) => grant.grantId)).toEqual(['own']);
    expect(state.app).toHaveBeenCalledWith(expect.any(NextRequest), { scope: undefined });
    expect(state.session).not.toHaveBeenCalled();
  });
  it('accepts session bearers only through the existing notAppToken fallback', async () => {
    const result = await GET(request('', { Authorization: 'Bearer fixture-session-reference' }));
    expect(result.status).toBe(200);
    expect(state.app).toHaveBeenCalledOnce();
    expect(state.session).toHaveBeenCalledOnce();
  });
  it('does not fall back from refused app authentication to a privileged session', async () => {
    state.app.mockResolvedValue({ error: 'Forbidden', status: 403 });
    expect((await GET(request('', { 'X-App-DID': AGENT }))).status).toBe(403);
    expect(state.session).not.toHaveBeenCalled();
    expect(state.cards).not.toHaveBeenCalled();
  });
  it.each([{ error: 'Unauthenticated', status: 401 }, { identity: { id: '' } }])('rejects unauthenticated identities %j', async session => {
    state.session.mockResolvedValue(session);
    const result = await GET(request());
    expect(result.status).toBe(401);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(state.cards).not.toHaveBeenCalled();
  });
  it('returns a sanitized 503, not partial metadata, on storage failure', async () => {
    state.cards.mockRejectedValueOnce(new Error('private internal diagnostic'));
    const result = await GET(request());
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: 'zone_grants_unavailable' });
  });
  it('supports preflight without authentication or metadata access', async () => {
    const result = await OPTIONS(request());
    expect(result.status).toBe(204);
    expect(state.session).not.toHaveBeenCalled();
    expect(state.cards).not.toHaveBeenCalled();
  });
});
