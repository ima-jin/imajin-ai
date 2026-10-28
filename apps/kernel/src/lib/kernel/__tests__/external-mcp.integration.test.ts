import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import type { Identity } from '@imajin/auth';
import type { VaultFile } from '@imajin/vault-core';
import { readFileSync } from 'node:fs';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const h = vi.hoisted(() => ({
  db: null as unknown, identity: {} as Identity, nodeDid: '', log: vi.fn(), publish: vi.fn(),
  vault: { version: 1, entries: [] } as VaultFile, authError: false, appError: false,
  app: null as null | { appDid: string; userDid: string; isServiceToken: boolean; scopes: string[] },
  fetch: vi.fn(), saveError: false, outputs: [] as unknown[], secrets: [] as string[],
}));
vi.mock('@/src/db', async () => {
  const auth = await import('@/src/db/schemas/auth');
  const vault = await import('@/src/db/schemas/vault');
  const connectors = await import('@/src/db/schemas/connectors');
  const registry = await import('@/src/db/schemas/registry');
  return {
    ...auth, ...vault, ...connectors, ...registry,
    db: new Proxy({}, { get: (_target, property) => {
      const database = h.db as Record<PropertyKey, unknown>;
      const value = database[property];
      return typeof value === 'function' ? value.bind(database) : value;
    } }),
  };
});
vi.mock('@imajin/auth', async original => ({
  ...await original<typeof import('@imajin/auth')>(),
  requireAuth: vi.fn(async () => h.authError ? { error: 'Rejected', status: 401 } : { identity: h.identity }),
  requireAppAuth: vi.fn(async () => h.appError || !h.app
    ? { error: 'Rejected', status: 403 } : { appAuth: h.app }),
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ debug: h.log, info: h.log, warn: h.log, error: h.log }) }));
vi.mock('@imajin/bus', () => ({ publish: h.publish }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => h.nodeDid }));
vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  connectorRegistryId: (memberDid: string, provider: string) => `conn_${memberDid}_${provider}`,
}));
vi.mock('@/src/lib/vault/vault-repository', () => ({
  getVaultRepository: () => ({
    load: async () => structuredClone(h.vault),
    save: async (vault: VaultFile) => {
      if (h.saveError) throw new Error('Synthetic storage failure');
      h.vault = structuredClone(vault);
    },
  }),
}));
import { identities, identityMembers, attestations, channelLinks } from '@/src/db/schemas/auth';
import { registryApps } from '@/src/db/schemas/registry';
import { connectors } from '@/src/db/schemas/connectors';
import { vaultDelegationGrants, vaultOwnerEnvelopes, vaultGrantRequests } from '@/src/db/schemas/vault';
import { canonicalize, crypto, generateKeypair, requireAuth, requireAppAuth } from '@imajin/auth';
import { _resetSealingCache, getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { fetchGrantSecret, loadAndUnseal, loadAndUnsealByGrantee, listRenewableGrants } from '@/src/lib/vault';
import { connectExternalMcp, disconnectExternalMcp, invokeExternalMcp } from '../external-mcp';
import { parseExternalMcpCall, POSTMAN_MCP_URL, EXTERNAL_MCP_SCOPE } from '../external-mcp-policy';
import { GET, POST, DELETE, OPTIONS } from '@/app/connections/api/external-mcp/postman/route';
import { POST as RPC, OPTIONS as RPC_OPTIONS } from '@/app/connections/api/external-mcp/postman/rpc/route';

const tables = [identities, identityMembers, attestations, channelLinks, registryApps, connectors,
  vaultDelegationGrants, vaultOwnerEnvelopes, vaultGrantRequests];
const keys = generateKeypair();
let client: PGlite;
let database: ReturnType<typeof drizzle>;
let sequence = 0;
let member: string;
let org: string;
let appDid: string;
function tableSql(table: PgTable) {
  const config = getTableConfig(table);
  const fields = config.columns.map(column => {
    let fallback = '';
    if (['created_at', 'updated_at', 'issued_at'].includes(column.name)) fallback = ' DEFAULT now()';
    else if (typeof column.default === 'string') fallback = ` DEFAULT '${column.default}'`;
    else if (typeof column.default === 'boolean' || typeof column.default === 'number') fallback = ` DEFAULT ${column.default}`;
    else if (column.getSQLType() === 'jsonb' && column.default !== undefined) fallback = " DEFAULT '[]'::jsonb";
    else if (column.getSQLType() === 'text[]' && column.default !== undefined) fallback = " DEFAULT '{}'::text[]";
    return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${fallback}`;
  });
  return `CREATE TABLE "${config.schema}"."${config.name}" (${fields.join(',')})`;
}
function fakeSecret() {
  const value = `FAKE_MCP_CREDENTIAL_NOT_VALID_${sequence}`;
  h.secrets.push(value);
  return value;
}
function rpcCall(name = 'getCollections', args: Record<string, unknown> = { workspace: 'bedrock-test-workspace' }) {
  return { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name, arguments: args } };
}
function rpcResponse(id: number, result: unknown) {
  return Response.json({ jsonrpc: '2.0', id, result });
}
async function call(handler: typeof GET, method = 'GET', input?: unknown, headers: Record<string, string> = {}, raw?: string) {
  const response = await handler(new NextRequest('https://kernel.test/connections/api/external-mcp/postman', {
    method, headers, ...(input === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(input) }),
  }));
  const result = { status: response.status, body: await response.json(), headers: response.headers };
  h.outputs.push(result.body);
  return result;
}
async function connect(tagged = true) {
  return call(POST, 'POST', { secret: fakeSecret(), ...(tagged ? { orgContextDid: org } : {}) });
}
async function installApp(service = true, grant = true) {
  await database.insert(registryApps).values({
    id: `app_${sequence}`, appDid, name: 'Fake Artifact Service', ownerDid: org,
    publicKey: keys.publicKey, callbackUrl: 'https://artifact.test/callback',
    approvedServiceScopes: [EXTERNAL_MCP_SCOPE],
  });
  if (grant) await database.insert(channelLinks).values({
    id: `cl_${sequence}`, channel: 'app', channelUid: member, did: member, appDid,
    status: 'active', scopes: [EXTERNAL_MCP_SCOPE],
  });
  h.app = { appDid, userDid: service ? '' : member, isServiceToken: service, scopes: [EXTERNAL_MCP_SCOPE] };
}
beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel; CREATE SCHEMA registry;');
  for (const table of tables) await client.exec(tableSql(table));
  await client.exec(`
    CREATE UNIQUE INDEX conn_tuple ON kernel.connectors (owner_did,provider,slot);
    CREATE UNIQUE INDEX owner_envelope ON kernel.vault_owner_envelopes (field,key_id);
    CREATE UNIQUE INDEX uniq_vault_delegation_active ON kernel.vault_delegation_grants (subject,granted_to,field,key_id) WHERE status='active';
  `);
  database = drizzle(client);
  h.db = database;
  // Real additive migration twice: no data/history deletion and no renumbered baseline.
  const migration = readFileSync('migrations/0224_external_mcp_org_context.sql', 'utf8');
  await client.exec(migration);
  await client.exec(migration);
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey);
  vi.stubEnv('VAULT_OWNER_X_PUB', '');
  vi.stubEnv('VAULT_OWNER_ED_PUB', '');
  _resetSealingCache();
  h.nodeDid = getNodeSigningIdentity().senderDid;
  sequence++;
  member = `did:imajin:mcpmember${sequence}`;
  org = `did:imajin:mcporg${sequence}`;
  appDid = `did:imajin:mcpapp${sequence}`;
  h.identity = { id: member, scope: 'actor', subtype: 'human' };
  h.app = null; h.authError = false; h.appError = false; h.saveError = false;
  h.outputs = []; h.secrets = [];
  h.publish.mockResolvedValue(undefined);
  await database.insert(identities).values([
    { id: member, publicKey: keys.publicKey, scope: 'actor' },
    { id: org, publicKey: keys.publicKey, scope: 'business' },
  ]);
  await database.insert(identityMembers).values({
    id: `im_${sequence}`, identityDid: org, memberDid: member, role: 'member',
  });
  vi.stubGlobal('fetch', h.fetch);
  h.fetch.mockImplementation(async (_url, options) => {
    const message = JSON.parse(options.body);
    if (message.method === 'initialize') return rpcResponse(1, { protocolVersion: '2025-06-18', capabilities: {} });
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return rpcResponse(2, { content: [{ type: 'text', text: 'Bedrock collection' }] });
  });
});
afterEach(async () => {
  const rows = await Promise.all(tables.map(table => database.select().from(table)));
  const exposed = JSON.stringify([rows, h.vault, h.outputs, h.log.mock.calls, h.publish.mock.calls]);
  for (const secret of h.secrets) expect(exposed.includes(secret), 'Credential escaped into persistence/response/log').toBe(false);
  vi.unstubAllGlobals();
});
afterAll(async () => { await client.close(); vi.unstubAllEnvs(); _resetSealingCache(); });

describe('personal external MCP: real SQL, signatures and vault crypto', () => {
  it('connects under member custody, injects on every hop, and logs member/org without key or arguments', async () => {
    expect((await connect()).status).toBe(201);
    const status = await call(GET);
    expect(status.body).toEqual({ provider: 'postman', connected: true, orgContextDid: org });
    expect(requireAuth).toHaveBeenCalledWith(expect.anything(), { sessionOnly: true, service: 'connections' });
    const result = await call(RPC, 'POST', rpcCall());
    expect(result.status).toBe(200);
    expect(result.body.result.content[0].text).toContain('Bedrock');
    expect(h.fetch).toHaveBeenCalledTimes(3);
    for (const [url, options] of h.fetch.mock.calls) {
      expect(url).toBe(POSTMAN_MCP_URL);
      expect(options).toMatchObject({ redirect: 'error', cache: 'no-store' });
      expect(options.headers.Authorization).toBe(`Bearer ${h.secrets[0]}`);
      expect(options.body.includes(h.secrets[0])).toBe(false);
    }
    const [row] = await database.select().from(connectors).where(eq(connectors.ownerDid, member));
    const [grant] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.field, row.sealedKeyField!));
    expect(grant).toMatchObject({ subject: member, grantedTo: h.nodeDid, status: 'active' });
    const logs = await database.select().from(attestations).where(eq(attestations.subjectDid, member));
    expect(logs).toHaveLength(2);
    expect(logs[1].payload).toMatchObject({ action: 'call', memberDid: member, orgContextDid: org, tool: 'getCollections' });
    expect(logs[1].payload).not.toHaveProperty('arguments');
    expect(crypto.verifySync(logs[1].signature, canonicalize({
      subject_did: member, type: logs[1].type, context_id: logs[1].contextId,
      context_type: logs[1].contextType, payload: logs[1].payload, issued_at: logs[1].issuedAt.getTime(),
    }), keys.publicKey)).toBe(true);
    expect(result.headers.get('cache-control')).toBe('no-store');
  });
  it('refuses raw-key fetch via all generic vault paths even for the custody grantee', async () => {
    await connect();
    const [row] = await database.select().from(connectors).where(eq(connectors.ownerDid, member));
    const [grant] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.field, row.sealedKeyField!));
    expect(await fetchGrantSecret({ grantId: grant.id, granteeDid: h.nodeDid })).toEqual({ status: 'not_grantee' });
    await expect(loadAndUnseal(row.sealedKeyField!)).rejects.toThrow();
    await expect(loadAndUnsealByGrantee(row.sealedKeyField!, h.nodeDid)).rejects.toThrow();
    const renewable = await listRenewableGrants({ nodeDid: h.nodeDid });
    expect(renewable.some(item => item.field === row.sealedKeyField)).toBe(false);
  });
  it('disconnect tombstones the vault key, erases wrapped custody, keeps rows and denies future calls', async () => {
    await connect();
    const [before] = await database.select().from(connectors).where(eq(connectors.ownerDid, member));
    expect((await call(DELETE, 'DELETE')).body).toEqual({ disconnected: true });
    const [after] = await database.select().from(connectors).where(eq(connectors.id, before.id));
    expect(after.status).toBe('revoked');
    const [grant] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.field, before.sealedKeyField!));
    expect(grant).toMatchObject({ status: 'revoked', wrappedKey: '', wrappedNonce: '' });
    expect(h.vault.entries.find(entry => entry.field === before.sealedKeyField && entry.deleted)).toBeDefined();
    expect((await call(RPC, 'POST', rpcCall())).status).toBe(403);
    expect(h.fetch).not.toHaveBeenCalled();
    expect((await call(GET)).body.connected).toBe(false);
    expect((await connect()).status).toBe(201);
    const [reconnected] = await database.select().from(connectors).where(eq(connectors.id, before.id));
    expect(reconnected.sealedKeyField).not.toBe(before.sealedKeyField);
  });
  it('records failed upstream calls without persisting or echoing provider errors', async () => {
    await connect();
    h.fetch.mockRejectedValue(new Error(h.secrets[0]));
    expect((await call(RPC, 'POST', rpcCall())).status).toBe(502);
    const logs = await database.select().from(attestations).where(eq(attestations.subjectDid, member));
    expect(logs).toHaveLength(2);
  });
  it('fails closed on vault write failure and preserves the existing connection', async () => {
    await connect();
    const [before] = await database.select().from(connectors).where(eq(connectors.ownerDid, member));
    h.saveError = true;
    expect((await connect()).status).toBe(503);
    expect(await database.select().from(connectors).where(eq(connectors.ownerDid, member))).toEqual([before]);
    h.saveError = false;
    expect((await call(RPC, 'POST', rpcCall())).status).toBe(200);
  });
  it('supports an untagged personal connection and a no-op disconnect', async () => {
    expect((await call(DELETE, 'DELETE')).body).toEqual({ disconnected: true });
    expect((await call(GET)).body.connected).toBe(false);
    expect((await connect(false)).body.orgContextDid).toBeNull();
    expect((await call(RPC, 'POST', rpcCall())).status).toBe(200);
  });
  it.each(['removed-member', 'suspended-org', 'suspended-member', 'revoked-connection', 'expired-custody', 'revoked-custody'])(
    'rechecks %s on every call', async boundary => {
      await connect();
      if (boundary === 'removed-member') await database.update(identityMembers).set({ removedAt: new Date() }).where(eq(identityMembers.memberDid, member));
      if (boundary === 'suspended-org') await database.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, org));
      if (boundary === 'suspended-member') await database.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, member));
      if (boundary === 'revoked-connection') await database.update(connectors).set({ status: 'revoked' }).where(eq(connectors.ownerDid, member));
      if (boundary.endsWith('custody')) await database.update(vaultDelegationGrants)
        .set(boundary === 'expired-custody' ? { expiresAt: new Date(0) } : { status: 'revoked' })
        .where(eq(vaultDelegationGrants.subject, member));
      expect((await call(RPC, 'POST', rpcCall())).status).toBe(403);
      expect(h.fetch).not.toHaveBeenCalled();
    });
  it.each([true, false])('allows a consenting live app, service=%s, without giving it the key', async service => {
    await connect(); await installApp(service);
    expect((await call(RPC, 'POST', { ...rpcCall(), memberDid: member }, { authorization: 'Bearer FAKE_APP_TOKEN' })).status).toBe(200);
    expect(requireAppAuth).toHaveBeenCalledWith(expect.anything(), { scope: EXTERNAL_MCP_SCOPE });
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });
  it.each(['no-consent', 'revoked-consent', 'dropped-scope', 'inactive-app', 'no-approval', 'wrong-member'])(
    'refuses app boundary %s', async boundary => {
      await connect(); await installApp(true, boundary !== 'no-consent');
      if (boundary === 'revoked-consent') await database.update(channelLinks).set({ revokedAt: new Date() }).where(eq(channelLinks.did, member));
      if (boundary === 'dropped-scope') await database.update(channelLinks).set({ scopes: [] }).where(eq(channelLinks.did, member));
      if (boundary === 'inactive-app') await database.update(registryApps).set({ status: 'revoked' }).where(eq(registryApps.appDid, appDid));
      if (boundary === 'no-approval') await database.update(registryApps).set({ approvedServiceScopes: [] }).where(eq(registryApps.appDid, appDid));
      const selected = boundary === 'wrong-member' ? org : member;
      expect((await call(RPC, 'POST', { ...rpcCall(), memberDid: selected }, { authorization: 'Bearer FAKE_APP_TOKEN' })).status).toBe(403);
      expect(h.fetch).not.toHaveBeenCalled();
    });
  it('never permits org act-as, agents or delegated apps to connect or disconnect a personal key', async () => {
    for (const identity of [{ ...h.identity, actingAs: org }, { ...h.identity, actingFor: member },
      { ...h.identity, subtype: 'agent' }, { ...h.identity, scope: 'business' }]) {
      h.identity = identity;
      expect((await connect()).status).toBe(403);
      expect((await call(DELETE, 'DELETE')).status).toBe(403);
    }
    h.authError = true;
    expect((await call(GET)).status).toBe(401);
    expect((await call(RPC, 'POST', rpcCall())).status).toBe(401);
  });
  it('does not fall back to a session when app authentication fails or selector disagrees', async () => {
    await connect(); h.appError = true;
    expect((await call(RPC, 'POST', rpcCall(), { authorization: 'Bearer FAKE_APP_TOKEN' })).status).toBe(403);
    h.appError = false; await installApp(false);
    expect((await call(RPC, 'POST', { ...rpcCall(), memberDid: org }, { 'x-app-did': appDid })).status).toBe(403);
    expect((await call(RPC, 'POST', { ...rpcCall(), memberDid: org })).status).toBe(403);
    h.app!.isServiceToken = true;
    expect((await call(RPC, 'POST', rpcCall(), { authorization: 'Bearer FAKE_APP_TOKEN' })).status).toBe(403);
  });
  it.each(['createCollection', 'putEnvironment', 'runCollection', 'sendRequest', 'getUnknown', '__proto__'])(
    'refuses %s before unseal or any network access', async name => {
      await connect();
      const result = await call(RPC, 'POST', rpcCall(name, {}));
      expect(result.status).toBe(403);
      expect(result.body.error).toContain('read-only');
      expect(h.fetch).not.toHaveBeenCalled();
    });
  it.each([null, [], { secret: '' }, { secret: 'bad\nheader' }, { secret: 'fake', url: 'http://localhost' },
    { secret: 'fake', orgContextDid: 'not-a-did' }])('rejects invalid connection input %j', async input => {
      expect((await call(POST, 'POST', input)).status).toBe(400);
    });
  it('bounds and validates bodies without echoing them; handles CORS preflight', async () => {
    expect((await call(POST, 'POST', undefined, {}, '{bad')).status).toBe(400);
    expect((await call(POST, 'POST', { secret: 'x'.repeat(17000) })).status).toBe(413);
    expect((await call(POST, 'POST')).status).toBe(400);
    expect((await call(RPC, 'POST', { ...rpcCall(), memberDid: 123 })).status).toBe(400);
    for (const handler of [OPTIONS, RPC_OPTIONS]) {
      expect((await handler(new NextRequest('https://kernel.test', { method: 'OPTIONS' }))).status).toBe(204);
    }
  });
  it('refuses invalid org context and Tier 1 before sealing', async () => {
    expect((await call(POST, 'POST', { secret: 'FAKE_NOT_VALID', orgContextDid: 'did:imajin:unknown' })).status).toBe(403);
    vi.stubEnv('VAULT_OWNER_X_PUB', 'fake-public'); vi.stubEnv('VAULT_OWNER_ED_PUB', 'fake-public');
    expect((await connect()).status).toBe(409);
  });
  it('enforces policy even when a kernel caller skips the route validator', async () => {
    await expect(async () => invokeExternalMcp({ memberDid: member }, rpcCall('runCollection') as never)).rejects.toThrow('Tool refused');
    expect(parseExternalMcpCall(rpcCall()).params?.name).toBe('getCollections');
    expect(() => connectExternalMcp(member, { secret: 'fake', orgContextDid: 'did:imajin:fake' })).toThrow('Invalid organization');
    await disconnectExternalMcp(member);
  });
});
