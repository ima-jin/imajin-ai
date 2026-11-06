import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { and, eq, SQL } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import type { Identity } from '@imajin/auth';
import type { VaultFile } from '@imajin/vault-core';

const h = vi.hoisted(() => ({
  db: null as unknown, identity: {} as Identity, nodeDid: '',
  vault: { version: 1, entries: [] } as VaultFile, log: vi.fn(),
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'), ...await import('@/src/db/schemas/connectors'),
  ...await import('@/src/db/schemas/vault'), ...await import('@/src/db/schemas/registry'),
  ...await import('@/src/db/schemas/profile'), ...await import('@/src/db/schemas/usage'),
  ...await import('@/src/db/schemas/pay'), ...await import('@/src/db/schemas/connections'),
  ...await import('@/src/db/schemas/www'),
  get db() { return h.db; },
}));
// Only the human session transport is supplied; bot requests use the real
// app JWT verifier and live assignment/connection/custody queries.
vi.mock('@imajin/auth', async original => ({
  ...await original<typeof import('@imajin/auth')>(),
  requireAuth: vi.fn(async () => ({ identity: h.identity })),
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ debug: h.log, info: h.log, warn: h.log, error: h.log }),
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => h.nodeDid }));
vi.mock('@/src/lib/notify/connector-events', () => ({
  notifyConnectorCredentialSealed: vi.fn().mockResolvedValue(undefined),
  notifyConnectorCredentialUnsealed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/src/lib/vault/vault-repository', () => ({
  getVaultRepository: () => ({
    load: async () => structuredClone(h.vault),
    save: async (vault: VaultFile) => { h.vault = structuredClone(vault); },
  }),
}));
vi.mock('@imajin/config', async original => ({
  ...await original<typeof import('@imajin/config')>(),
  rateLimit: () => ({ limited: false }), getClientIP: () => '127.0.0.1',
}));

import { provideInternalApiKey } from '@imajin/auth';
import { identities, identityMembers, attestations, storedKeys, channelLinks, delegationGrants } from '@/src/db/schemas/auth';
import { profiles } from '@/src/db/schemas/profile';
import { connectors, orgConnectionMemberGrants, orgConnectionSuspensions } from '@/src/db/schemas/connectors';
import { vaultDelegationGrants, vaultOwnerEnvelopes } from '@/src/db/schemas/vault';
import { registryApps } from '@/src/db/schemas/registry';
import { getNodeSigningIdentity, _resetSealingCache } from '@/src/lib/vault/sealing';
import { resolveAgentAuthority } from '@/src/lib/auth/agent-authority';
import { createAppToken } from '@/src/lib/auth/jwt';
import { POST as verifyToken } from '@/app/auth/api/apps/token/verify/route';
import { GET as usableModels } from '@/app/infer/v1/models/usable/route';
import { hasOrgConnectionProvenance } from '@/src/lib/kernel/member-connection-gate';
import { seedOrgWithAssignedBot } from './seed-org-with-assigned-bot';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let client: PGlite;
let database: ReturnType<typeof drizzle>;
const nodeKeys = generateKeyPairSync('ed25519');
const tables = [identities, identityMembers, attestations, storedKeys, channelLinks, delegationGrants,
  profiles, connectors, orgConnectionMemberGrants, orgConnectionSuspensions, vaultDelegationGrants,
  vaultOwnerEnvelopes, registryApps];

function tableSql(table: PgTable) {
  const { schema, name, columns } = getTableConfig(table);
  const dialect = new PgDialect();
  const fields = columns.map(column => {
    const value = column.default;
    let fallback = '';
    if (value instanceof SQL) fallback = ` DEFAULT ${dialect.sqlToQuery(value).sql}`;
    else if (typeof value === 'string') fallback = ` DEFAULT '${value.replaceAll("'", "''")}'`;
    else if (typeof value === 'boolean' || typeof value === 'number') fallback = ` DEFAULT ${value}`;
    return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${fallback}`;
  });
  return `CREATE TABLE "${schema}"."${name}" (${fields.join(',')})`;
}

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel; CREATE SCHEMA profile; CREATE SCHEMA registry;');
  for (const table of tables) await client.exec(tableSql(table));
  await client.exec(`
    CREATE UNIQUE INDEX seed_connector_slot ON kernel.connectors(owner_did,provider,slot);
    CREATE UNIQUE INDEX seed_owner_envelope ON kernel.vault_owner_envelopes(field,key_id);
    CREATE UNIQUE INDEX seed_custody ON kernel.vault_delegation_grants(subject,granted_to,field,key_id) WHERE status='active';
  `);
  database = drizzle(client);
  h.db = database;
  h.log.mockImplementation((data, message) => {
    if (message === 'Register error') throw new Error(`Registration setup: ${String(data.err).split('\n')[0]}`);
  });
  vi.stubEnv('AUTH_PRIVATE_KEY', nodeKeys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'));
  vi.stubEnv('GROUP_KEY_ENCRYPTION_SECRET', randomUUID());
  vi.stubEnv('VAULT_OWNER_X_PUB', '');
  vi.stubEnv('VAULT_OWNER_ED_PUB', '');
  vi.stubEnv('NEXT_PUBLIC_DISABLE_INVITE_GATE', 'true');
  vi.stubEnv('AUTH_SERVICE_URL', 'https://kernel.test/auth');
  _resetSealingCache();
  h.nodeDid = getNodeSigningIdentity().senderDid;
  provideInternalApiKey(randomUUID());
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/apps/token/verify')) return verifyToken(new NextRequest(url, init));
    if (url.endsWith('/api/internal/verify-delegation')) {
      const body = JSON.parse(String(init?.body));
      return Response.json(await resolveAgentAuthority(body.agentDid, body.principalDid));
    }
    if (url.includes('/controllers/')) {
      const parts = new URL(url).pathname.split('/');
      const [membership] = await database.select().from(identityMembers).where(and(
        eq(identityMembers.identityDid, decodeURIComponent(parts.at(-3)!)),
        eq(identityMembers.memberDid, decodeURIComponent(parts.at(-1)!)),
      ));
      return Response.json({ valid: !!membership && !membership.removedAt, role: membership?.role,
        allowedServices: membership?.allowedServices ?? null });
    }
    if (url === 'https://api.anthropic.com/v1/models') {
      return Response.json({ data: [{ id: 'claude-scenario', display_name: 'Scenario model' }] });
    }
    throw new Error('Unexpected network request in isolated org-bot scenario');
  }));
});
afterEach(() => { h.log.mockClear(); });
afterAll(async () => {
  await client.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetSealingCache();
});

async function scenario(seal: Parameters<typeof seedOrgWithAssignedBot>[0]['seal']) {
  return seedOrgWithAssignedBot({ seal, authenticate: identity => { h.identity = identity; } });
}
async function discover(seed: Awaited<ReturnType<typeof scenario>>) {
  const token = await createAppToken({
    azp: seed.botDid, sub: seed.botDid, scope: 'infer:completions', attestationId: randomUUID(),
  });
  return usableModels(new NextRequest('https://kernel.test/infer/v1/models/usable', {
    headers: { 'x-api-key': token, 'x-acting-as': seed.orgDid },
  }));
}

describe('assigned org-bot discovery seeded by real writers (#3335)', () => {
  it('discovers the node-self-granted connector written by the legacy token-paste writer', async () => {
    const seed = await scenario('legacy-token-paste');
    const [connection] = await database.select().from(connectors).where(eq(connectors.ownerDid, seed.orgDid));
    const [custody] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.field, seed.field));
    expect(connection).toMatchObject({
      provider: 'anthropic', slot: 'primary', status: 'active', sealedKeyField: seed.field, orgContextDid: null,
    });
    expect(custody).toMatchObject({ subject: h.nodeDid, grantedTo: h.nodeDid, status: 'active', oneTime: false });
    const response = await discover(seed);
    const body = await response.json();
    const refusingCheck = !hasOrgConnectionProvenance(connection)
      ? 'authorizeMemberConnection -> hasOrgConnectionProvenance: loadedByDid and loadedAt are missing from the real writer'
      : 'connection provenance present; inspect discovery response';
    expect(response.status, `${refusingCheck}; response=${JSON.stringify(body)}`).toBe(200);
    expect(body.data).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'claude-scenario', imajin: expect.objectContaining({ credentialDid: seed.orgDid }),
    })]));
  });

  it('records the current authenticated org-route writer shape without hand-written fixture rows', async () => {
    const seed = await scenario('authenticated-org-route');
    const [connection] = await database.select().from(connectors).where(eq(connectors.ownerDid, seed.orgDid));
    const [custody] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.field, seed.field));
    expect(connection).toMatchObject({ loadedByDid: seed.humanDid, loadedAt: expect.any(Date) });
    expect(custody).toMatchObject({ subject: seed.orgDid, grantedTo: h.nodeDid, status: 'active', oneTime: false });
    const response = await discover(seed);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(await database.select().from(orgConnectionMemberGrants)).toEqual([]);
  });
});
