import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { canonicalize, crypto } from '@imajin/auth';
import type { Identity } from '@imajin/auth';
import { NextRequest } from 'next/server';
import { setVaultInternalApiKey } from '../../../../../../packages/auth/tests/support/internal-post-test-env';

vi.setConfig({ hookTimeout: 30_000 });
const h = vi.hoisted(() => ({ db: null as unknown, destroy: vi.fn(), legacyDestroy: vi.fn(), nodeDid: 'did:imajin:test-node' }));
vi.mock('@/src/db', async () => {
  const { connectors } = await import('@/src/db/schemas/connectors');
  const { attestations, channelLinks, identityMembers } = await import('@/src/db/schemas/auth');
  const { forwardingDb } = await import('@/src/lib/notify/__tests__/pglite-connector-inbox-harness');
  return { db: forwardingDb(() => h.db), connectors, attestations, channelLinks, identityMembers };
});

vi.mock('@/src/lib/vault/delete-secret', () => ({ deleteSecretAndRevokeGrants: h.destroy }));
vi.mock('@/src/lib/vault', () => ({ deleteFromVault: h.legacyDestroy, vaultFieldExists: vi.fn() }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));
vi.mock('../node-identity', () => ({ getNodeDid: async () => h.nodeDid }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));

import { removeConnectorConnection as removeConnection } from '../connector-removal';
import { createDisconnectHandler } from '../connector-oauth-routes';
import { assertConnectionNotRemoved } from '../connector-connection-status';
import { recordConnectorRegistration, revokeConnectorRegistration, syncConnectorRegistrationScopes, renameConnectorConnection, createConnectorConnection } from '../connector-registry-store';
import { connectors } from '@/src/db/schemas/connectors';
import { attestations, channelLinks, identityMembers } from '@/src/db/schemas/auth';

const keys = crypto.generateKeypair();
const owner = 'did:imajin:owner';
let client: PGlite;
let database: ReturnType<typeof drizzle>;

function removeConnectorConnection(ownerDid: string, provider: string, slot: string, prefixes: string[],
  actor: Identity = { id: ownerDid, scope: 'actor' }) {
  return removeConnection(ownerDid, provider, slot, prefixes, actor);
}

function createTable(table: PgTable) {
  const config = getTableConfig(table);
  const columns = config.columns.map(column => {
    let defaultSql = '';
    if (['created_at', 'updated_at', 'issued_at'].includes(column.name)) defaultSql = ' DEFAULT now()';
    else if (typeof column.default === 'string') defaultSql = ` DEFAULT '${column.default}'`;
    else if (column.name === 'scopes') defaultSql = " DEFAULT '[]'::jsonb";
    return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${defaultSql}`;
  });
  return `CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(',')})`;
}

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel;');
  for (const table of [connectors, channelLinks, attestations, identityMembers]) await client.exec(createTable(table));
  await client.exec('CREATE UNIQUE INDEX uniq_connector ON kernel.connectors(owner_did,provider,slot);');
  database = drizzle(client);
  h.db = database;
});
afterAll(async () => client.close());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setVaultInternalApiKey(undefined);
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey);
  h.destroy.mockReset().mockResolvedValue(undefined);
  // Test fixtures are reset without deleting application history.
  await client.exec('TRUNCATE kernel.connectors, auth.channel_links, auth.attestations, auth.identity_members;');
});

async function seed(provider = 'github', did = owner, slot = 'work') {
  await database.insert(connectors).values({
    id: `${did}-${provider}-${slot}`, ownerDid: did, provider, slot, label: 'Company',
    channel: provider, connectorDid: `did:imajin:${provider}-connector`, status: 'active',
  });
  await database.insert(channelLinks).values({
    id: `${did}-${provider}-${slot}`, did, channel: provider, channelUid: `${did}-${slot}`,
    appDid: `did:imajin:${provider}-connector`, slot, scopes: [`${provider}:read`], status: 'active',
  });
}

describe('per-slot attested removal', () => {
  it.each(['github', 'google', 'quickbooks'])('destroys %s credentials via the vault API and hides history without deleting rows', async provider => {
    await seed(provider);
    await seed(provider, owner, 'primary');
    await seed(provider, 'did:imajin:other');
    await database.insert(channelLinks).values({
      id: 'consumer', did: owner, channel: provider, channelUid: 'consumer', appDid: 'did:imajin:consumer',
      slot: 'work', scopes: [`${provider}:read`], status: 'active',
    });
    const prefixes = [`${provider}-config`, `${provider}-oauth`, ...(provider === 'github' ? ['github-pat'] : [])];
    expect(await removeConnectorConnection(owner, provider, 'work', prefixes)).toEqual({ removed: true, slot: 'work' });
    expect(h.destroy.mock.calls.map(([field]) => field)).toEqual(prefixes.map(prefix => `${prefix}:${owner}:work`));
    const rows = await database.select().from(connectors);
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.ownerDid === owner && row.slot === 'work')?.status).toBe('removed');
    expect(rows.filter(row => row.status === 'active')).toHaveLength(2);
    const grants = await database.select().from(channelLinks);
    expect(grants.filter(row => row.did === owner && row.slot === 'work').every(row => row.status === 'revoked')).toBe(true);
    expect(grants.filter(row => row.status === 'active')).toHaveLength(2);
    const [audit] = await database.select().from(attestations);
    expect(audit).toMatchObject({ subjectDid: owner, type: 'connector.disconnected', payload: {
      ownerDid: owner, connector: provider, slot: 'work', action: 'removed',
      actorDid: owner, delegateDid: null, actingFor: null, authorityBasis: 'self', groupRole: null,
    } });
    const canonical = canonicalize({
      subject_did: owner, type: audit.type, context_id: audit.contextId, context_type: audit.contextType,
      payload: audit.payload, issued_at: audit.issuedAt.getTime(),
    });
    expect(crypto.verifySync(audit.signature, canonical, keys.publicKey)).toBe(true);
    await expect(assertConnectionNotRemoved(owner, provider, 'work')).rejects.toThrow('Connection removed');
    await expect(assertConnectionNotRemoved(owner, provider, 'primary')).resolves.toBeUndefined();
    await expect(assertConnectionNotRemoved('did:imajin:other', provider, 'work')).resolves.toBeUndefined();
    await removeConnectorConnection(owner, provider, 'work', prefixes);
    expect(await database.select().from(attestations)).toHaveLength(1);
    expect(h.destroy).toHaveBeenCalledTimes(prefixes.length);
  });

  it('rejects cross-DID removal without destroying vault fields or changing the owned row', async () => {
    await seed();
    await expect(removeConnectorConnection('did:imajin:attacker', 'github', 'work', ['github-oauth'])).rejects.toMatchObject({ status: 404 });
    expect(h.destroy).not.toHaveBeenCalled();
    expect((await database.select().from(connectors))[0].status).toBe('active');
    expect(await database.select().from(attestations)).toHaveLength(0);
  });

  it.each(['primary', '../primary'])('blocks primary or invalid selector %s before any destruction', slot => {
    expect(() => removeConnectorConnection(owner, 'github', slot, ['github-oauth'])).toThrow();
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it('does not claim success when custody destruction fails; retry completes the attested change', async () => {
    await seed();
    h.destroy.mockRejectedValueOnce(new Error('vault unavailable'));
    await expect(removeConnectorConnection(owner, 'github', 'work', ['github-oauth'])).rejects.toThrow('vault unavailable');
    expect((await database.select().from(connectors))[0].status).toBe('active');
    expect(await database.select().from(attestations)).toHaveLength(0);
    await removeConnectorConnection(owner, 'github', 'work', ['github-oauth']);
    expect((await database.select().from(connectors))[0].status).toBe('removed');
  });

  it('does not destroy custody without a signing identity', async () => {
    await seed();
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    await expect(removeConnectorConnection(owner, 'github', 'work', ['github-oauth'])).rejects.toThrow();
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it('cannot resurrect or rename a removed slot via old connect, scope-sync or disconnect writes', async () => {
    await seed();
    await removeConnectorConnection(owner, 'github', 'work', ['github-oauth']);
    await recordConnectorRegistration({ ownerDid: owner, provider: 'github', slot: 'work' });
    await syncConnectorRegistrationScopes(owner, 'github', ['github:read'], 'work');
    await revokeConnectorRegistration(owner, 'github', 'work');
    expect(await renameConnectorConnection(owner, 'github', 'work', 'Renamed')).toBeUndefined();
    await expect(createConnectorConnection(owner, 'github', 'work', 'Reused')).rejects.toThrow('connection_exists');
    const [row] = await database.select().from(connectors).where(eq(connectors.slot, 'work'));
    expect(row.status).toBe('removed');
    expect(row.label).toBe('Company');
    expect(row.scopes).toEqual([]);
  });
});

describe('removal authority through the real requireAuth and policy rails', () => {
  const person = 'did:imajin:person';
  const group = 'did:imajin:group';
  const agent = 'did:imajin:agent';
  const prefixes = ['github-config', 'github-oauth', 'github-pat'];
  const handler = createDisconnectHandler({
    vaultPrefixes: prefixes, channel: 'github', connectorName: 'github',
    connectorDid: 'did:imajin:github-connector', allowSlotRemoval: true,
  });

  function authenticate(id = person, controller: Record<string, unknown> = { valid: true, role: 'owner', allowedServices: null }) {
    vi.stubEnv('AUTH_SERVICE_URL', 'https://auth.test');
    vi.stubEnv('AUTH_INTERNAL_API_KEY', 'local-delegation-fixture');
    setVaultInternalApiKey('local-controller-fixture');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/session')) return Response.json({ did: id, scope: 'actor', subtype: 'human' });
      if (url.endsWith('/api/internal/verify-delegation')) return Response.json({ allowed: true });
      return Response.json(controller);
    }));
  }

  function request(headers: Record<string, string> = {}, query = '', body: unknown = {}) {
    return new NextRequest(`https://kernel.test/github/api/disconnect?slot=work&remove=true${query}`, {
      method: 'POST', headers: { cookie: 'imajin_session=local-session-fixture', ...headers },
      body: JSON.stringify(body),
    });
  }

  async function snapshot() {
    return { registry: await database.select().from(connectors), grants: await database.select().from(channelLinks) };
  }

  async function untouched(before: Awaited<ReturnType<typeof snapshot>>) {
    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.legacyDestroy).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(await database.select().from(attestations)).toHaveLength(0);
  }

  it.each(['github', 'google', 'quickbooks'])('refuses a coarse X-Acting-For agent on %s without destroying anything', async provider => {
    await seed(provider);
    const before = await snapshot();
    authenticate(agent);
    const remove = createDisconnectHandler({
      vaultPrefixes: [`${provider}-config`, `${provider}-oauth`], channel: provider,
      connectorName: provider, connectorDid: `did:imajin:${provider}-connector`, allowSlotRemoval: true,
    });
    const response = await remove(request({ 'x-acting-for': owner }, '', { countersignature: 'not-an-owner-approval' }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: 'AGENT_APPROVAL_REQUIRED', class: 'irreversible', ownerDid: owner, delegateDid: agent,
    });
    await untouched(before);
  });

  it('refuses unauthenticated removal before any custody or row changes', async () => {
    await seed();
    const before = await snapshot();
    const response = await handler(new NextRequest('https://kernel.test/github/api/disconnect?slot=work&remove=true', { method: 'POST' }));
    expect(response.status).toBe(401);
    await untouched(before);
  });

  it.each(['', person])('refuses internal owner overrides from actor %j without act-as authority', async id => {
    await seed();
    const before = await snapshot();
    await expect(removeConnectorConnection(owner, 'github', 'work', prefixes, { id, scope: 'actor' })).rejects.toMatchObject({ status: 403 });
    await untouched(before);
  });

  it.each([
    { role: 'maintainer', allowedServices: null, removedAt: null },
    { role: 'agent', allowedServices: null, removedAt: null },
    { role: 'owner', allowedServices: ['google'], removedAt: null },
    { role: 'admin', allowedServices: [], removedAt: null },
    { role: 'owner', allowedServices: null, removedAt: new Date('2026-10-01') },
  ])('refuses current role/service/membership $role $allowedServices $removedAt despite cached owner authority', async ({ role, allowedServices, removedAt }) => {
    await seed('github', group);
    await database.insert(identityMembers).values({ identityDid: group, memberDid: person, role, allowedServices, removedAt });
    const before = await snapshot();
    authenticate();
    expect((await handler(request({ 'x-acting-as': group }))).status).toBe(403);
    await untouched(before);
  });

  it('passes the connector service to requireAuth and rejects a controller scoped to other services', async () => {
    await seed('github', group);
    await database.insert(identityMembers).values({ identityDid: group, memberDid: person, role: 'owner', allowedServices: ['google'] });
    const before = await snapshot();
    authenticate(person, { valid: true, role: 'owner', allowedServices: ['google'] });
    expect((await handler(request({ 'x-acting-as': group }))).status).toBe(403);
    await untouched(before);
  });

  it.each([false, true])('refuses a forged group selector without membership (coarse response valid=%s)', async valid => {
    await seed('github', group);
    const before = await snapshot();
    authenticate(person, { valid, role: 'owner', allowedServices: null });
    expect((await handler(request({ 'x-acting-as': group }))).status).toBe(403);
    await untouched(before);
  });

  it('returns 404 for another DID’s slot, ignoring body and query DID selectors', async () => {
    await seed();
    const before = await snapshot();
    authenticate(person);
    expect((await handler(request({}, `&did=${owner}`, { ownerDid: owner }))).status).toBe(404);
    await untouched(before);
  });

  it.each([['owner', null], ['admin', ['github']]] as const)('permits a current %s with matching/unrestricted scope and signs the person and authority', async (role, services) => {
    await seed('github', group);
    await database.insert(identityMembers).values({
      identityDid: group, memberDid: person, role, allowedServices: services ? [...services] : null,
    });
    authenticate();
    expect((await handler(request({ 'x-acting-as': group }, '&did=did:imajin:other', {
      ownerDid: 'did:imajin:other', actorDid: 'did:forged', delegateDid: 'did:forged', secret: keys.privateKey,
    }))).status).toBe(200);
    const [audit] = await database.select().from(attestations);
    expect(audit.payload).toEqual({
      ownerDid: group, connector: 'github', slot: 'work', action: 'removed',
      actorDid: person, delegateDid: null, actingFor: null, authorityBasis: 'group-role', groupRole: role,
      context_id: group, context_type: 'github',
    });
    expect(JSON.stringify(audit.payload).includes(keys.privateKey), 'Audit must not contain signing or request secret material').toBe(false);
    expect(h.destroy.mock.calls.map(([field]) => field)).toEqual(prefixes.map(prefix => `${prefix}:${group}:work`));
    expect(h.legacyDestroy).not.toHaveBeenCalled();
  });

  it('refuses a delegated identity even at the internal removal seam', async () => {
    await seed();
    const before = await snapshot();
    await expect(removeConnectorConnection(owner, 'github', 'work', prefixes, { id: agent, scope: 'actor', actingFor: owner })).rejects.toMatchObject({ status: 403 });
    await untouched(before);
  });
});
