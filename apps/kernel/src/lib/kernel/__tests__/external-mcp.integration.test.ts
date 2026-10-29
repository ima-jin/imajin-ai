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
  fetch: vi.fn(), upstream: vi.fn(), saveError: false, outputs: [] as unknown[], secrets: [] as string[],
  openTransactions: 0, transactionsStarted: 0, selectReads: 0,
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
      if (property === 'select' && typeof value === 'function') {
        return (...args: unknown[]) => { h.selectReads++; return value.apply(database, args); };
      }
      if (property === 'transaction' && typeof value === 'function') {
        return async (work: (tx: unknown) => Promise<unknown>) => {
          let started = false;
          try {
            return await value.call(database, (tx: unknown) => {
              started = true;
              h.transactionsStarted++;
              h.openTransactions++;
              return work(tx);
            });
          } finally {
            if (started) h.openTransactions--;
          }
        };
      }
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
vi.mock('../egress-fetch', () => ({ egressSafeFetch: h.upstream }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => h.nodeDid }));
vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  connectorRegistryId: (memberDid: string, provider: string) => `conn_${memberDid}_${provider}`,
}));
vi.mock('@/src/lib/vault/vault-repository', () => ({
  getVaultRepository: () => ({
    load: async () => structuredClone(h.vault),
    save: async (vault: VaultFile) => {
      if (h.saveError) throw new Error(h.secrets.at(-1) ?? 'Synthetic storage failure');
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
import { fetchGrantSecret, loadAndUnseal, loadAndUnsealByGrantee, listRenewableGrants, vaultService } from '@/src/lib/vault';
import { connectExternalMcp, disconnectExternalMcp, invokeExternalMcp } from '../external-mcp';
import { parseExternalMcpCall, POSTMAN_MCP_URL, EXTERNAL_MCP_SCOPE } from '../external-mcp-policy';
import { GET, POST, DELETE, OPTIONS } from '@/app/connections/api/external-mcp/postman/route';
import { POST as RPC, OPTIONS as RPC_OPTIONS } from '@/app/connections/api/external-mcp/postman/rpc/route';
import { EXTERNAL_MCP_APP_LIMIT, EXTERNAL_MCP_IN_FLIGHT_LIMIT, EXTERNAL_MCP_MEMBER_LIMIT } from '../external-mcp-limits';
import { GET as DECLARATION, PUT as DECLARE, OPTIONS as DECLARE_OPTIONS } from '@/app/connections/api/upstreams/route';
import { GET as CONNECTION_STATUS, POST as CONNECT_UPSTREAM, DELETE as DISCONNECT_UPSTREAM, OPTIONS as CONNECTION_OPTIONS } from '@/app/connections/api/upstreams/connection/route';
import { POST as UPSTREAM, OPTIONS as UPSTREAM_OPTIONS } from '@/app/connections/api/upstreams/call/route';
import { UPSTREAM_READ_SCOPE, UPSTREAM_WRITE_SCOPE, upstreamProvider } from '../app-upstream-policy';
import { invokeAppUpstream } from '../app-upstream';
import { GET as ORG_LIST, OPTIONS as ORG_OPTIONS } from '@/app/connections/api/org-held/route';
import { GET as ORG_GET, POST as ORG_LOAD, DELETE as ORG_REMOVE, OPTIONS as ORG_PROVIDER_OPTIONS } from '@/app/connections/api/org-held/[provider]/route';

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
async function permanentState() {
  return JSON.stringify([await Promise.all(tables.map(table => database.select().from(table))), h.vault]);
}
async function expectAdmissionRefused(status: number, headers: Record<string, string> = {}, input = rpcCall()) {
  const before = await permanentState();
  const fetches = h.fetch.mock.calls.length;
  const transactions = h.transactionsStarted;
  const result = await call(RPC, 'POST', input, headers);
  expect(result.status).toBe(status);
  expect(h.fetch).toHaveBeenCalledTimes(fetches);
  expect(h.transactionsStarted).toBe(transactions);
  expect(await permanentState()).toBe(before);
  return result;
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
  const migration = readFileSync('migrations/0225_external_mcp_org_context.sql', 'utf8');
  await client.exec(migration);
  await client.exec(migration);
  const upstreamMigration = readFileSync('migrations/0226_app_upstreams.sql', 'utf8');
  await client.exec(upstreamMigration);
  await client.exec(upstreamMigration);
  const orgHeldMigration = readFileSync('migrations/0229_org_held_connections.sql', 'utf8');
  await client.exec(orgHeldMigration);
  await client.exec(orgHeldMigration);
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
  h.openTransactions = 0; h.transactionsStarted = 0; h.selectReads = 0;
  h.publish.mockResolvedValue(undefined);
  h.upstream.mockImplementation(async () => {
    expect(h.openTransactions).toBe(0);
    return Response.json({ items: ['fixture'] });
  });
  await database.insert(identities).values([
    { id: member, publicKey: keys.publicKey, scope: 'actor' },
    { id: org, publicKey: keys.publicKey, scope: 'business' },
  ]);
  await database.insert(identityMembers).values({
    id: `im_${sequence}`, identityDid: org, memberDid: member, role: 'member',
  });
  vi.stubGlobal('fetch', h.fetch);
  h.fetch.mockImplementation(async (_url, options) => {
    expect(h.openTransactions).toBe(0);
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
  it('returns 429 over the member limit without upstream, transactions or permanent writes, then recovers', async () => {
    await connect();
    for (let i = 0; i < EXTERNAL_MCP_MEMBER_LIMIT; i++) {
      expect((await call(RPC, 'POST', rpcCall())).status).toBe(200);
    }
    expect((await expectAdmissionRefused(429)).body).toEqual({ error: 'External MCP rate limit exceeded' });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
    try { expect((await call(RPC, 'POST', rpcCall())).status).toBe(200); }
    finally { vi.mocked(Date.now).mockRestore(); }
  });
  it('aggregates the app limit across consenting members with no permanent writes on 429', async () => {
    await connect(); await installApp();
    const headers = { authorization: 'Bearer FAKE_APP_TOKEN' };
    const initialMember = member;
    for (let i = 0; i <= EXTERNAL_MCP_APP_LIMIT / EXTERNAL_MCP_MEMBER_LIMIT; i++) {
      const target = i === 0 ? initialMember : `did:imajin:appquota${sequence}m${i}`;
      if (i > 0) {
        await database.insert(identities).values({ id: target, publicKey: keys.publicKey, scope: 'actor' });
        h.identity = { id: target, scope: 'actor', subtype: 'human' };
        expect((await connect(false)).status).toBe(201);
        await database.insert(channelLinks).values({
          id: `quota_${sequence}_${i}`, channel: 'app', channelUid: target, did: target, appDid,
          status: 'active', scopes: [EXTERNAL_MCP_SCOPE],
        });
      }
      const input = { ...rpcCall(), memberDid: target };
      if (i === EXTERNAL_MCP_APP_LIMIT / EXTERNAL_MCP_MEMBER_LIMIT) {
        expect((await expectAdmissionRefused(429, headers, input)).body).toEqual({ error: 'External MCP rate limit exceeded' });
      } else {
        for (let j = 0; j < EXTERNAL_MCP_MEMBER_LIMIT; j++) {
          expect((await call(RPC, 'POST', input, headers)).status).toBe(200);
        }
      }
    }
    expect(h.fetch).toHaveBeenCalledTimes(EXTERNAL_MCP_APP_LIMIT * 3);
  });
  it('caps global in-flight calls at 4 with no writes on 503 and releases capacity after upstream failure', async () => {
    await connect();
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    h.fetch.mockImplementation(async () => {
      await gate;
      throw new Error('Synthetic upstream failure');
    });
    const pending = Array.from({ length: EXTERNAL_MCP_IN_FLIGHT_LIMIT }, () => call(RPC, 'POST', rpcCall()));
    try {
      await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(EXTERNAL_MCP_IN_FLIGHT_LIMIT));
      expect(h.openTransactions).toBe(0);
      expect((await expectAdmissionRefused(503)).body).toEqual({ error: 'External MCP capacity unavailable' });
    } finally {
      unblock();
      expect((await Promise.all(pending)).every(result => result.status === 502)).toBe(true);
    }
    const next = await call(RPC, 'POST', rpcCall());
    expect(next.status).toBe(502);
    expect(h.fetch).toHaveBeenCalledTimes(EXTERNAL_MCP_IN_FLIGHT_LIMIT + 1);
  });
  it('disconnect completes while an admitted network call is pending and rejects subsequent calls', async () => {
    await connect();
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    h.fetch.mockImplementation(async (_url, options) => {
      expect(h.openTransactions).toBe(0);
      await gate;
      const message = JSON.parse(options.body);
      if (message.method === 'initialize') return rpcResponse(1, { protocolVersion: '2025-06-18' });
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return rpcResponse(2, { content: [] });
    });
    const pending = call(RPC, 'POST', rpcCall());
    try {
      await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
      expect((await call(DELETE, 'DELETE')).status).toBe(200);
      expect((await call(RPC, 'POST', rpcCall())).status).toBe(403);
      expect(h.fetch).toHaveBeenCalledTimes(1);
    } finally {
      unblock();
      expect((await pending).status).toBe(200);
    }
  });
  it('reconnect leaves only the new readable sealed key and tombstones the old field with retained grant history', async () => {
    await connect();
    const [before] = await database.select().from(connectors).where(eq(connectors.ownerDid, member));
    expect((await connect()).status).toBe(201);
    const [after] = await database.select().from(connectors).where(eq(connectors.id, before.id));
    expect(after.sealedKeyField).not.toBe(before.sealedKeyField);
    expect(await vaultService.get(before.sealedKeyField!)).toBeUndefined();
    expect(await vaultService.get(after.sealedKeyField!)).toBeDefined();
    const activeFields = (await vaultService.list()).filter(entry => entry.field.endsWith(`:${member}`));
    expect(activeFields.map(entry => entry.field)).toEqual([after.sealedKeyField]);
    const history = await vaultService.getHistory(before.sealedKeyField!);
    expect(history[0]).toMatchObject({ deleted: true, previousCid: history[1].cid });
    const [retired] = await database.select().from(vaultDelegationGrants)
      .where(eq(vaultDelegationGrants.field, before.sealedKeyField!));
    expect(retired).toMatchObject({ status: 'revoked', wrappedKey: '', wrappedNonce: '' });
    expect((await call(RPC, 'POST', rpcCall())).status).toBe(200);
  });
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

const upstreamOrigin = 'https://external-api.example';
const serviceHeaders = { authorization: 'Bearer FAKE_APP_TOKEN' };
function declaration(origin = upstreamOrigin) {
  return { id: 'catalog', origin, credentialHeader: 'X-API-Key', credentialPrefix: '',
    paths: [{ path: '/items', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }] };
}
function upstreamCall(extra: Record<string, unknown> = {}) {
  return { memberDid: member, upstreamId: 'catalog', path: '/items', method: 'GET', ...extra };
}
function selector() { return { appDid, upstreamId: 'catalog' }; }
async function installUpstream(write = false, tagged = true, grant = true, target = declaration()) {
  await installApp(true, grant);
  const scopes = [UPSTREAM_READ_SCOPE, ...(write ? [UPSTREAM_WRITE_SCOPE] : [])];
  await database.update(registryApps).set({ approvedServiceScopes: scopes }).where(eq(registryApps.appDid, appDid));
  await database.update(channelLinks).set({ scopes }).where(eq(channelLinks.did, member));
  h.app!.scopes = scopes;
  expect((await call(DECLARE, 'PUT', { upstreams: [target] }, serviceHeaders)).status).toBe(200);
  const connected = await call(CONNECT_UPSTREAM, 'POST', {
    ...selector(), origin: upstreamOrigin, secret: fakeSecret(), ...(tagged ? { orgContextDid: org } : {}),
  });
  expect(connected.status).toBe(201);
  return connected;
}
async function readUpstreamStatus() {
  const query = new URLSearchParams(selector()).toString();
  const response = await CONNECTION_STATUS(new NextRequest(`https://kernel.test/connections/api/upstreams/connection?${query}`));
  expect(response.status).toBe(200);
  const result = await response.json();
  h.outputs.push(result);
  return result;
}
async function expectUpstreamRefused(status: number, input: unknown = upstreamCall()) {
  const before = await permanentState();
  const upstreamCalls = h.upstream.mock.calls.length;
  const result = await call(UPSTREAM, 'POST', input, serviceHeaders);
  expect(result.status).toBe(status);
  expect(h.upstream).toHaveBeenCalledTimes(upstreamCalls);
  expect(await permanentState()).toBe(before);
  return result;
}
describe('registered app service → declared external API', () => {
  it('rate-limits before any database read or transaction and writes no refusal audit', async () => {
    await installUpstream();
    for (let i = 0; i < EXTERNAL_MCP_MEMBER_LIMIT; i++) {
      expect((await call(UPSTREAM, 'POST', upstreamCall(), serviceHeaders)).status).toBe(200);
    }
    const reads = h.selectReads;
    const transactions = h.transactionsStarted;
    await expectUpstreamRefused(429);
    expect(h.selectReads).toBe(reads);
    expect(h.transactionsStarted).toBe(transactions);
  });
  it('caps in-flight app calls before DB access, releases capacity, and holds no transaction across I/O', async () => {
    await installUpstream();
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    h.upstream.mockImplementation(async () => {
      expect(h.openTransactions).toBe(0);
      await gate;
      return Response.json({ items: [] });
    });
    const pending = Array.from({ length: EXTERNAL_MCP_IN_FLIGHT_LIMIT }, () => call(UPSTREAM, 'POST', upstreamCall(), serviceHeaders));
    try {
      await vi.waitFor(() => expect(h.upstream).toHaveBeenCalledTimes(EXTERNAL_MCP_IN_FLIGHT_LIMIT));
      const reads = h.selectReads;
      const transactions = h.transactionsStarted;
      await expectUpstreamRefused(503);
      expect(h.selectReads).toBe(reads);
      expect(h.transactionsStarted).toBe(transactions);
    } finally { unblock(); }
    expect((await Promise.all(pending)).every(result => result.status === 200)).toBe(true);
    expect((await call(UPSTREAM, 'POST', upstreamCall(), serviceHeaders)).status).toBe(200);
  });
  it('does not let an operator-approved app create audit records for a member who never consented', async () => {
    await installUpstream(false, true, false);
    await expectUpstreamRefused(403);
  });
  it('refuses a different active, operator-approved app without writing against the selected member', async () => {
    await installUpstream();
    const otherAppDid = `did:imajin:otherapp${sequence}`;
    await database.insert(registryApps).values({
      id: `other_${sequence}`, appDid: otherAppDid, name: 'Other app', ownerDid: org,
      publicKey: keys.publicKey, callbackUrl: 'https://other.test/callback',
      approvedServiceScopes: [UPSTREAM_READ_SCOPE], upstreams: [declaration()],
    });
    h.app!.appDid = otherAppDid;
    await expectUpstreamRefused(403);
  });
  it('injects only inside the kernel, preserves upstream status/body but no headers, and signs member/app/org audit', async () => {
    await installUpstream();
    h.upstream.mockResolvedValue(new Response('{"items":[1]}', { status: 201, headers: {
      'x-debug-credential': h.secrets[0], 'set-cookie': 'private=upstream',
    } }));
    const response = await call(UPSTREAM, 'POST', upstreamCall(), serviceHeaders);
    expect(response).toMatchObject({ status: 200, body: { status: 201, body: '{"items":[1]}' } });
    expect(response.headers.get('x-debug-credential')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(requireAppAuth).toHaveBeenCalledWith(expect.anything(), { scope: UPSTREAM_READ_SCOPE });
    expect(h.upstream).toHaveBeenCalledWith(`${upstreamOrigin}/items`, {
      method: 'GET', body: undefined, headers: { 'X-API-Key': h.secrets[0], 'Content-Type': 'application/json' },
    }, { connector: 'app-upstream', timeoutMs: 30_000, allowPrivate: false });
    const logs = await database.select().from(attestations).where(eq(attestations.subjectDid, member));
    expect(logs.filter(row => (row.payload as { action: string }).action === 'call')).toHaveLength(1);
    expect(logs.at(-1)?.payload).toMatchObject({
      memberDid: member, appDid, orgContextDid: org, action: 'call', method: 'GET', reason: null, outcome: 'returned',
    });
    const [row] = await database.select().from(connectors).where(eq(connectors.ownerDid, member));
    const [custody] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.field, row.sealedKeyField!));
    expect(custody).toMatchObject({ subject: member, grantedTo: h.nodeDid, purpose: UPSTREAM_READ_SCOPE });
    expect(await fetchGrantSecret({ grantId: custody.id, granteeDid: appDid })).toEqual({ status: 'not_grantee' });
    await expect(loadAndUnseal(row.sealedKeyField!)).rejects.toThrow();
  });
  it.each(['GET', 'HEAD'])('allows %s with only the read grant', async method => {
    await installUpstream(false, false);
    expect((await call(UPSTREAM, 'POST', upstreamCall({ method }), serviceHeaders)).status).toBe(200);
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('requires explicit per-app member and operator write grants for %s', async method => {
    await installUpstream();
    h.app!.scopes = [UPSTREAM_READ_SCOPE, UPSTREAM_WRITE_SCOPE];
    const input = upstreamCall({ method, reason: 'member-request', body: '{"action":"fixture"}' });
    await expectUpstreamRefused(403, input);
    await database.update(registryApps).set({ approvedServiceScopes: [UPSTREAM_READ_SCOPE, UPSTREAM_WRITE_SCOPE] }).where(eq(registryApps.appDid, appDid));
    await expectUpstreamRefused(403, input);
    await database.update(channelLinks).set({ scopes: [UPSTREAM_READ_SCOPE, UPSTREAM_WRITE_SCOPE] }).where(eq(channelLinks.did, member));
    h.app!.scopes = [UPSTREAM_READ_SCOPE];
    await expectUpstreamRefused(403, input);
    h.app!.scopes = [UPSTREAM_READ_SCOPE, UPSTREAM_WRITE_SCOPE];
    expect((await call(UPSTREAM, 'POST', input, serviceHeaders)).status).toBe(200);
    const logs = await database.select().from(attestations).where(eq(attestations.subjectDid, member));
    expect(logs.at(-1)?.payload).toMatchObject({ method, reason: 'member-request', outcome: 'returned', appDid });
    expect(h.upstream).toHaveBeenCalledTimes(1);
  });
  it('revokes an active app connection on personal disconnect and reconnects with fresh custody', async () => {
    await installUpstream();
    expect((await call(UPSTREAM, 'POST', upstreamCall(), serviceHeaders)).status).toBe(200);
    expect((await call(DISCONNECT_UPSTREAM, 'DELETE', selector())).status).toBe(200);
    await expectUpstreamRefused(403);
    expect(h.upstream).toHaveBeenCalledTimes(1);
    expect((await call(CONNECT_UPSTREAM, 'POST', {
      ...selector(), origin: upstreamOrigin, secret: fakeSecret(), orgContextDid: org,
    })).status).toBe(201);
    expect((await call(UPSTREAM, 'POST', upstreamCall(), serviceHeaders)).status).toBe(200);
    expect(h.upstream.mock.calls.at(-1)?.[1].headers['X-API-Key']).toBe(h.secrets[1]);
  });
  it.each(['revoked', 'suspended', 'removed', 'expired'])('denies connection status %s on the next call', async status => {
    await installUpstream();
    expect((await call(UPSTREAM, 'POST', upstreamCall(), serviceHeaders)).status).toBe(200);
    await database.update(connectors).set(status === 'expired' ? { expiresAt: new Date(0) } : { status })
      .where(eq(connectors.ownerDid, member));
    await expectUpstreamRefused(403);
    expect(h.upstream).toHaveBeenCalledTimes(1);
  });
  it.each(['removed-member', 'suspended-org', 'suspended-member', 'revoked-consent', 'missing-scope', 'revoked-custody', 'expired-custody', 'inactive-app', 'revoked-app', 'no-operator-approval'])(
    'rechecks %s before each app call', async boundary => {
      await installUpstream();
      expect((await call(UPSTREAM, 'POST', upstreamCall(), serviceHeaders)).status).toBe(200);
      if (boundary === 'removed-member') await database.update(identityMembers).set({ removedAt: new Date() }).where(eq(identityMembers.memberDid, member));
      if (boundary === 'suspended-org' || boundary === 'suspended-member') await database.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, boundary === 'suspended-org' ? org : member));
      if (boundary === 'revoked-consent') await database.update(channelLinks).set({ revokedAt: new Date() }).where(eq(channelLinks.did, member));
      if (boundary === 'missing-scope') await database.update(channelLinks).set({ scopes: [] }).where(eq(channelLinks.did, member));
      if (boundary === 'revoked-custody' || boundary === 'expired-custody') await database.update(vaultDelegationGrants)
        .set(boundary === 'expired-custody' ? { expiresAt: new Date(0) } : { status: 'revoked' }).where(eq(vaultDelegationGrants.subject, member));
      if (boundary === 'inactive-app') await database.update(registryApps).set({ status: 'revoked' }).where(eq(registryApps.appDid, appDid));
      if (boundary === 'revoked-app') await database.update(registryApps).set({ revokedAt: new Date() }).where(eq(registryApps.appDid, appDid));
      if (boundary === 'no-operator-approval') await database.update(registryApps).set({ approvedServiceScopes: [] }).where(eq(registryApps.appDid, appDid));
      await expectUpstreamRefused(403);
      expect(h.upstream).toHaveBeenCalledTimes(1);
    });
  it.each([{ path: '/other' }, { path: '/items', method: 'TRACE' }, { upstreamId: 'unknown' }])('refuses undeclared target %j', async extra => {
    await installUpstream();
    await expectUpstreamRefused(extra.method === 'TRACE' ? 400 : 403, upstreamCall(extra));
    expect(h.upstream).not.toHaveBeenCalled();
  });
  it('refuses a declared path with an undeclared HTTP method without writing an audit', async () => {
    await installUpstream(true, true, true, { ...declaration(), paths: [{ path: '/items', methods: ['GET'] }] });
    await expectUpstreamRefused(403, upstreamCall({ method: 'POST', reason: 'app-workflow' }));
    expect(h.upstream).not.toHaveBeenCalled();
  });
  it('binds custody to the member-approved destination and injection shape, not the current app declaration', async () => {
    await installUpstream();
    for (const changed of [{ origin: 'https://different.example' }, { credentialHeader: 'Authorization' }, { credentialPrefix: 'Bearer ' }]) {
      await call(DECLARE, 'PUT', { upstreams: [{ ...declaration(), ...changed }] }, serviceHeaders);
      await expectUpstreamRefused(403);
    }
    expect(h.upstream).not.toHaveBeenCalled();
  });
  it('disconnects even after app revocation, retaining connection and sealed history', async () => {
    await installUpstream();
    await database.update(registryApps).set({ status: 'revoked' }).where(eq(registryApps.appDid, appDid));
    expect((await call(DISCONNECT_UPSTREAM, 'DELETE', selector())).status).toBe(200);
    const [row] = await database.select().from(connectors).where(eq(connectors.ownerDid, member));
    expect(row.status).toBe('revoked');
    expect((await vaultService.getHistory(row.sealedKeyField!))[0].deleted).toBe(true);
    await expectUpstreamRefused(403);
  });
  it.each(['raw', 'base64', 'escaped', 'exception'])('never releases %s credential echoes or provider exceptions', async encoding => {
    await installUpstream();
    const before = await database.select().from(attestations);
    const secret = h.secrets[0];
    if (encoding === 'exception') h.upstream.mockRejectedValue(new Error(secret));
    else h.upstream.mockResolvedValue(Response.json({
      echo: encoding === 'base64' ? Buffer.from(secret).toString('base64') : encoding === 'escaped' ? JSON.stringify(secret) : secret,
    }));
    expect((await call(UPSTREAM, 'POST', upstreamCall(), serviceHeaders)).status).toBe(502);
    const after = await database.select().from(attestations);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)?.payload).toMatchObject({
      action: 'call', outcome: 'upstream-failed', appDid, memberDid: member, orgContextDid: org,
    });
    // afterEach additionally asserts every persisted row, app response, bus event and log is credential-free.
  });
  it('rejects a wrong member, another app, delegated token, and unauthenticated service', async () => {
    await installUpstream();
    await expectUpstreamRefused(403, upstreamCall({ memberDid: org }));
    h.app!.appDid = 'did:imajin:anotherapp';
    await expectUpstreamRefused(403);
    h.app!.appDid = appDid; h.app!.isServiceToken = false;
    await expectUpstreamRefused(403);
    expect((await call(DECLARE, 'PUT', { upstreams: [] }, serviceHeaders)).status).toBe(403);
    h.appError = true;
    await expectUpstreamRefused(403);
    expect(h.upstream).not.toHaveBeenCalled();
    await expect(invokeAppUpstream({ memberDid: org, appDid, serviceToken: true }, upstreamCall())).rejects.toThrow();
    await expect(invokeAppUpstream({ memberDid: member }, upstreamCall())).rejects.toThrow();
  });
  it('refuses mutation without a reason; keeps declarations on the authenticated app row with history', async () => {
    await installUpstream(true);
    await expectUpstreamRefused(400, upstreamCall({ method: 'POST' }));
    expect(h.upstream).not.toHaveBeenCalled();
    const logs = await database.select().from(attestations).where(eq(attestations.subjectDid, appDid));
    expect(logs[0].payload).toMatchObject({ action: 'upstreams-declared', appDid, upstreams: [declaration()] });
    await call(DECLARE, 'PUT', { upstreams: [] }, serviceHeaders);
    await expectUpstreamRefused(403);
    const [app] = await database.select().from(registryApps).where(eq(registryApps.appDid, appDid));
    expect(app.upstreams).toEqual([]);
    expect(await database.select().from(connectors).where(eq(connectors.provider, upstreamProvider(appDid, 'catalog')))).toHaveLength(1);
  });
  it('exposes declarations and status only to a personal member, with no-store and CORS', async () => {
    await installUpstream();
    const query = new URLSearchParams(selector()).toString();
    const read = async (handler: typeof GET) => handler(new NextRequest(`https://kernel.test/connections/api/upstreams?${query}`));
    expect(await (await read(DECLARATION)).json()).toEqual(declaration());
    expect(await (await read(CONNECTION_STATUS)).json()).toMatchObject({ connected: true, orgContextDid: org });
    h.identity = { ...h.identity, actingAs: org };
    expect((await read(DECLARATION)).status).toBe(403);
    expect((await call(CONNECT_UPSTREAM, 'POST', {})).status).toBe(403);
    for (const handler of [DECLARE_OPTIONS, CONNECTION_OPTIONS, UPSTREAM_OPTIONS]) {
      expect((await handler(new NextRequest('https://kernel.test', { method: 'OPTIONS' }))).status).toBe(204);
    }
  });
  it('rejects stale member approval of the destination and malformed, oversized or injected bodies', async () => {
    await installUpstream();
    const before = await permanentState();
    expect((await call(CONNECT_UPSTREAM, 'POST', {
      ...selector(), origin: 'https://different.example', secret: fakeSecret(),
    })).status).toBe(409);
    expect((await call(UPSTREAM, 'POST', undefined, serviceHeaders, '{bad')).status).toBe(400);
    expect((await call(UPSTREAM, 'POST', undefined, serviceHeaders)).status).toBe(400);
    expect((await call(UPSTREAM, 'POST', { body: 'x'.repeat(17000) }, serviceHeaders)).status).toBe(413);
    expect((await call(DECLARE, 'PUT', { upstreams: [declaration()], appDid: org }, serviceHeaders)).status).toBe(400);
    expect(h.upstream).not.toHaveBeenCalled();
    expect(await permanentState()).toBe(before);
  });
  const approvedPaths = [
    { path: '/items', methods: ['GET', 'HEAD'] }, { path: '/me', methods: ['GET'] },
  ];
  it.each([
    ['changed-path', [{ path: '/other', methods: ['GET', 'HEAD'] }, approvedPaths[1]]],
    ['added-path', [...approvedPaths, { path: '/other', methods: ['GET'] }]],
    ['added-method', [{ path: '/items', methods: ['GET', 'HEAD', 'DELETE'] }, approvedPaths[1]]],
    ['removed-path', [approvedPaths[0]]],
    ['removed-method', [{ path: '/items', methods: ['GET'] }, approvedPaths[1]]],
  ] as const)('invalidates %s before unseal or audit until the member reconnects', async (_name, paths) => {
    await installUpstream(true, true, true, { ...declaration(), paths: structuredClone(approvedPaths) });
    expect((await readUpstreamStatus()).connected).toBe(true);
    expect((await call(UPSTREAM, 'POST', upstreamCall(), serviceHeaders)).status).toBe(200);
    expect((await call(DECLARE, 'PUT', { upstreams: [{ ...declaration(), paths }] }, serviceHeaders)).status).toBe(200);
    expect((await readUpstreamStatus()).connected).toBe(false);
    const readKey = vi.spyOn(vaultService, 'get');
    try {
      const refused = await expectUpstreamRefused(403);
      expect(refused.body).toEqual({ error: 'No active personal external MCP connection or grant' });
      expect(readKey).not.toHaveBeenCalled();
    } finally { readKey.mockRestore(); }
    expect((await call(CONNECT_UPSTREAM, 'POST', {
      ...selector(), origin: upstreamOrigin, secret: fakeSecret(), orgContextDid: org,
    })).status).toBe(201);
    expect((await readUpstreamStatus()).connected).toBe(true);
    expect((await call(UPSTREAM, 'POST', upstreamCall({ path: paths[0].path }), serviceHeaders)).status).toBe(200);
  });
  it.each(['unchanged', 'reordered'])('keeps an %s declaration connected and returns the plain-text approval list', async kind => {
    const connected = await installUpstream(false, true, true, { ...declaration(), paths: structuredClone(approvedPaths) });
    const permissions = ['GET /items', 'GET /me', 'HEAD /items'];
    expect(connected.body.permissions).toEqual(permissions);
    expect(await readUpstreamStatus()).toMatchObject({ connected: true, permissions });
    const paths = kind === 'unchanged' ? approvedPaths : [
      approvedPaths[1], { path: '/items', methods: ['HEAD', 'GET'] },
    ];
    expect((await call(DECLARE, 'PUT', { upstreams: [{ ...declaration(), paths }] }, serviceHeaders)).status).toBe(200);
    expect(await readUpstreamStatus()).toMatchObject({ connected: true, permissions });
    const before = await database.select().from(attestations);
    expect((await call(UPSTREAM, 'POST', upstreamCall(), serviceHeaders)).status).toBe(200);
    expect(await database.select().from(attestations)).toHaveLength(before.length + 1);
  });
});

async function asOrg(role = 'admin') {
  await database.update(identityMembers).set({ role }).where(eq(identityMembers.memberDid, member));
  h.identity = { id: member, scope: 'actor', subtype: 'human', actingAs: org, actingAsRole: role };
}
async function orgRequest(method = 'GET', provider = 'anthropic', input?: unknown, raw?: string) {
  const handler = method === 'POST' ? ORG_LOAD : method === 'DELETE' ? ORG_REMOVE : ORG_GET;
  const response = await handler(new NextRequest(`https://kernel.test/connections/api/org-held/${provider}`, {
    method, ...(input === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(input) }),
  }), { params: Promise.resolve({ provider }) });
  const body = await response.json();
  h.outputs.push(body);
  return { status: response.status, body, headers: response.headers };
}
function orgKey() {
  // Generated test-only bytes, never a provider credential or snapshot.
  const secret = `fixture_${generateKeypair().publicKey}`;
  h.secrets.push(secret);
  return { secret };
}
async function orgRows() {
  return database.select().from(connectors).where(eq(connectors.ownerDid, org));
}
async function changeOrgBoundary(boundary: string) {
  const changes: Record<string, () => unknown> = {
    member: () => database.update(identityMembers).set({ role: 'member' }).where(eq(identityMembers.memberDid, member)),
    maintainer: () => database.update(identityMembers).set({ role: 'maintainer' }).where(eq(identityMembers.memberDid, member)),
    agent: () => database.update(identityMembers).set({ role: 'agent' }).where(eq(identityMembers.memberDid, member)),
    removed: () => database.update(identityMembers).set({ removedAt: new Date() }).where(eq(identityMembers.memberDid, member)),
    restricted: () => database.update(identityMembers).set({ allowedServices: ['auth'] }).where(eq(identityMembers.memberDid, member)),
    'suspended-org': () => database.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, org)),
    'suspended-actor': () => database.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, member)),
    'foreign-org': () => { h.identity.actingAs = 'did:imajin:foreignorg'; },
    'missing-org': () => database.update(identities).set({ id: `${org}missing` }).where(eq(identities.id, org)),
    personal: () => database.update(identities).set({ scope: 'actor' }).where(eq(identities.id, org)),
    delegated: () => { h.identity.actingFor = member; },
    'agent-session': () => { h.identity.subtype = 'agent'; },
    'agent-in-db': () => database.update(identities).set({ subtype: 'agent' }).where(eq(identities.id, member)),
    'no-act-as': () => { h.identity.actingAs = undefined; },
    'session-member': () => { h.identity.actingAsRole = 'member'; },
    unauthenticated: () => { h.authError = true; },
  };
  await changes[boundary]();
}
describe('org-held service keys: real SQL, signatures and private vault custody', () => {
  it('isolates org custody from the existing generic provider registration and revoke writers', async () => {
    await asOrg();
    const loaded = await orgRequest('POST', 'anthropic', orgKey());
    const [orgHeld] = await orgRows();
    const store = await vi.importActual<typeof import('../connector-registry-store')>('../connector-registry-store');
    await store.recordConnectorRegistration({ ownerDid: org, provider: 'anthropic', sealedKeyField: 'ordinary:fixture' });
    await store.revokeConnectorRegistration(org, 'anthropic');
    expect(await database.select().from(connectors).where(eq(connectors.id, orgHeld.id))).toEqual([orgHeld]);
    expect((await orgRequest()).body).toEqual(loaded.body);
    await expect(store.createConnectorConnection(org, 'org-held-anthropic')).rejects.toThrow('Unknown connector');
  });
  it('hides unconfigured slots and refuses removed slots without changing their history', async () => {
    await asOrg();
    expect((await orgRequest('DELETE')).body).toEqual({ revoked: true });
    await database.insert(connectors).values({
      id: `empty_org_${sequence}`, ownerDid: org, provider: 'org-held-anthropic', slot: 'primary',
      channel: 'anthropic', connectorDid: h.nodeDid,
    });
    expect((await call(ORG_LIST)).body).toEqual({ connections: [] });
    expect((await orgRequest()).status).toBe(404);
    await database.update(connectors).set({ status: 'removed' }).where(eq(connectors.ownerDid, org));
    const before = await permanentState();
    expect((await orgRequest('POST', 'anthropic', orgKey())).status).toBe(409);
    expect(await permanentState()).toBe(before);
  });
  it.each(['anthropic', 'warp', 'gemini'])('loads %s under the org DID and returns metadata only on load/get/list', async provider => {
    await asOrg();
    const input = orgKey();
    const loaded = await orgRequest('POST', provider, input);
    expect(loaded.status).toBe(201);
    expect(loaded.body).toEqual({ provider, loadedByDid: member, loadedAt: expect.any(String), status: 'loaded' });
    const [row] = await orgRows();
    expect(row).toMatchObject({ ownerDid: org, provider: `org-held-${provider}`, slot: 'primary', loadedByDid: member });
    const [grant] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.field, row.sealedKeyField!));
    expect(grant).toMatchObject({ subject: org, grantedTo: h.nodeDid, status: 'active' });
    const entry = await vaultService.get(row.sealedKeyField!);
    expect(entry?.custodyScheme).toBe('delegation-grant');
    const read = vi.spyOn(vaultService, 'get');
    try {
      expect((await orgRequest('GET', provider)).body).toEqual(loaded.body);
      expect((await call(ORG_LIST)).body).toEqual({ connections: [loaded.body] });
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
    expect(loaded.headers.get('cache-control')).toBe('no-store');
    expect(requireAuth).toHaveBeenCalledWith(expect.anything(), { sessionOnly: true, service: 'connections' });
    expect(await fetchGrantSecret({ grantId: grant.id, granteeDid: h.nodeDid })).toEqual({ status: 'not_grantee' });
    expect(await fetchGrantSecret({ grantId: grant.id, granteeDid: member })).toEqual({ status: 'not_grantee' });
    await expect(loadAndUnseal(row.sealedKeyField!)).rejects.toThrow();
    await expect(loadAndUnsealByGrantee(row.sealedKeyField!, h.nodeDid)).rejects.toThrow();
    expect((await listRenewableGrants({ nodeDid: h.nodeDid })).some(item => item.field === row.sealedKeyField)).toBe(false);
    const [event] = await database.select().from(attestations).where(eq(attestations.subjectDid, org));
    expect(event).toMatchObject({ type: 'connector.org-held', attestationStatus: null });
    expect(event.payload).toEqual({ actorDid: member, orgDid: org, provider, action: 'loaded' });
    expect(crypto.verifySync(event.signature, canonicalize({
      subject_did: org, type: event.type, context_id: event.contextId, context_type: event.contextType,
      payload: event.payload, issued_at: event.issuedAt.getTime(),
    }), keys.publicKey)).toBe(true);
  });
  it('replaces with immutable custody, revokes without deleting rows, hides history and can reload', async () => {
    await asOrg('owner');
    await orgRequest('POST', 'warp', orgKey());
    const [old] = await orgRows();
    const replacement = await orgRequest('POST', 'warp', orgKey());
    expect(replacement.status).toBe(201);
    const [current] = await orgRows();
    expect(current.sealedKeyField).not.toBe(old.sealedKeyField);
    expect((await vaultService.getHistory(old.sealedKeyField!))[0].deleted).toBe(true);
    const [retired] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.field, old.sealedKeyField!));
    expect(retired).toMatchObject({ status: 'revoked', wrappedKey: '', wrappedNonce: '' });
    expect((await orgRequest('DELETE', 'warp')).body).toEqual({ revoked: true });
    expect((await orgRequest('GET', 'warp')).status).toBe(404);
    expect((await call(ORG_LIST)).body).toEqual({ connections: [] });
    expect(await orgRows()).toHaveLength(1);
    expect((await orgRows())[0].status).toBe('revoked');
    expect((await vaultService.getHistory(current.sealedKeyField!))[0].deleted).toBe(true);
    const events = await database.select().from(attestations).where(eq(attestations.subjectDid, org));
    expect(events.map(event => event.payload)).toEqual(['loaded', 'replaced', 'revoked'].map(action => ({
      actorDid: member, orgDid: org, provider: 'warp', action,
    })));
    const grants = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.subject, org));
    expect(grants).toHaveLength(2);
    expect(grants.every(grant => grant.status === 'revoked' && grant.wrappedKey === '')).toBe(true);
    expect((await orgRequest('DELETE', 'warp')).status).toBe(200);
    expect(await database.select().from(attestations).where(eq(attestations.subjectDid, org))).toHaveLength(3);
    expect((await orgRequest('POST', 'warp', orgKey())).status).toBe(201);
  });
  it.each(['member', 'maintainer', 'agent', 'removed', 'restricted', 'suspended-org', 'suspended-actor', 'foreign-org',
    'missing-org', 'personal', 'delegated', 'agent-session', 'agent-in-db', 'no-act-as', 'session-member', 'unauthenticated'])(
    'refuses %s for load, read, list and removal without mutation', async boundary => {
      await asOrg();
      await orgRequest('POST', 'anthropic', orgKey());
      // The session keeps its stale admin role for live-DB boundary tests.
      await changeOrgBoundary(boundary);
      const before = await permanentState();
      const status = boundary === 'unauthenticated' ? 401 : 403;
      for (const method of ['POST', 'GET', 'DELETE']) {
        expect((await orgRequest(method, 'anthropic', method === 'POST' ? orgKey() : undefined)).status).toBe(status);
      }
      expect((await call(ORG_LIST)).status).toBe(status);
      expect(await permanentState()).toBe(before);
    });
  it.each([null, [], {}, { secret: '' }, { secret: 123 }, { secret: 'a\nb' }, { secret: 'a b' },
    { secret: 'x'.repeat(4097) }, { secret: 'fixture', ownerDid: 'did:imajin:override' },
    { secret: 'fixture', orgContextDid: 'did:imajin:override' }])('rejects invalid write shape %# without echo', async input => {
    await asOrg();
    const before = await permanentState();
    expect((await orgRequest('POST', 'anthropic', input)).status).toBe(400);
    expect(await permanentState()).toBe(before);
  });
  it('rejects unknown/OAuth providers, credential-bearing metadata, malformed/absent/oversized bodies, and Tier 1', async () => {
    await asOrg();
    const before = await permanentState();
    for (const provider of ['unknown', 'google', '__proto__']) expect((await orgRequest('POST', provider, orgKey())).status).toBe(400);
    expect((await orgRequest('POST', 'anthropic', { secret: org })).status).toBe(400);
    expect((await orgRequest('POST', 'anthropic', undefined, '{bad')).status).toBe(400);
    expect((await orgRequest('POST', 'anthropic')).status).toBe(400);
    expect((await orgRequest('POST', 'anthropic', { secret: 'x'.repeat(17000) })).status).toBe(413);
    vi.stubEnv('VAULT_OWNER_X_PUB', 'fake-public'); vi.stubEnv('VAULT_OWNER_ED_PUB', 'fake-public');
    expect((await orgRequest('POST', 'anthropic', orgKey())).status).toBe(409);
    expect(await permanentState()).toBe(before);
    for (const handler of [ORG_OPTIONS, ORG_PROVIDER_OPTIONS]) {
      expect((await handler(new NextRequest('https://kernel.test', { method: 'OPTIONS' }))).status).toBe(204);
    }
  });
  it('fails closed on storage and signing failures, without leaking errors or losing prior working custody', async () => {
    await asOrg();
    await orgRequest('POST', 'anthropic', orgKey());
    const before = await permanentState();
    h.saveError = true;
    expect((await orgRequest('POST', 'anthropic', orgKey())).status).toBe(503);
    expect((await orgRequest('DELETE')).status).toBe(503);
    expect(await permanentState()).toBe(before);
    h.saveError = false;
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    expect((await orgRequest('POST', 'anthropic', orgKey())).status).toBe(503);
    expect(await permanentState()).toBe(before);
  });
  it('does not change personal connection ownership or resolution alongside an org-held key', async () => {
    const personal = await connect();
    const before = await database.select().from(connectors).where(eq(connectors.ownerDid, member));
    await asOrg();
    await orgRequest('POST', 'anthropic', orgKey());
    expect(await database.select().from(connectors).where(eq(connectors.ownerDid, member))).toEqual(before);
    h.identity = { id: member, scope: 'actor', subtype: 'human' };
    expect((await call(GET)).body).toEqual(personal.body);
    expect((await call(RPC, 'POST', rpcCall())).status).toBe(200);
    expect(h.fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${h.secrets[0]}`);
  });
});
