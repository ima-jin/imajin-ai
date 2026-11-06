import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { and, eq, SQL } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import type { Identity } from '@imajin/auth';
import type { VaultFile } from '@imajin/vault-core';

const h = vi.hoisted(() => ({
  db: null as unknown, identity: {} as Identity, nodeDid: '',
  vault: { version: 1, entries: [] } as VaultFile, log: vi.fn(), internalKey: '',
  upstreamCalls: 0, expectedCredentialHash: '',
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
vi.mock('@imajin/bus', async () => ({
  publish: (await import('../../../../../../packages/bus/src/publish')).publish,
}));
// Isolate unrelated fan-out, not the usage publisher/reactor/signature writer.
vi.mock('../../../../../../packages/bus/src/subscriptions', () => ({ deliverToSubscribers: async () => {} }));
vi.mock('../../../../../../packages/bus/src/config', () => ({
  getChainConfig: async (type: string, scope: string) => ({
    eventType: type, scope, source: 'defaults',
    reactors: type === 'usage.incurred'
      ? [{ type: 'attestation', config: {}, enabled: true, await: true }] : [],
  }),
}));
vi.mock('@/src/lib/vault/internal-secret', () => ({ getInternalSecret: async () => h.internalKey }));
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

import { canonicalize, crypto, provideInternalApiKey } from '@imajin/auth';
import { identities, identityMembers, attestations, storedKeys, channelLinks, delegationGrants } from '@/src/db/schemas/auth';
import { profiles } from '@/src/db/schemas/profile';
import { connectors, orgConnectionEvents, orgConnectionMemberGrants, orgConnectionSuspensions } from '@/src/db/schemas/connectors';
import { vaultDelegationGrants, vaultOwnerEnvelopes } from '@/src/db/schemas/vault';
import { registryApps } from '@/src/db/schemas/registry';
import { getNodeSigningIdentity, _resetSealingCache } from '@/src/lib/vault/sealing';
import { resolveAgentAuthority } from '@/src/lib/auth/agent-authority';
import { createAppToken } from '@/src/lib/auth/jwt';
import { POST as verifyToken } from '@/app/auth/api/apps/token/verify/route';
import { GET as usableModels } from '@/app/infer/v1/models/usable/route';
import { POST as messages } from '@/app/infer/v1/messages/route';
import { POST as internalAttestation } from '@/app/auth/api/attestations/internal/route';
import { hasOrgConnectionProvenance } from '@/src/lib/kernel/member-connection-gate';
import { resolveBrain } from '../brain';
import { usageIncurred } from '@/src/db/schemas/usage';
import { transactions, balanceRollups } from '@/src/db/schemas/pay';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { revokeVaultDelegationGrantsForConnector } from '@/src/lib/vault';
import { changeOrgConnection } from '@/src/lib/kernel/org-connection-admin';
import { changeOrgConnectionMemberGrant } from '@/src/lib/kernel/org-connection-member-grants';
import { requireOrgConnectionMemberGrant } from '@/src/lib/kernel/org-connection-member-grants';
import { registerReactor } from '../../../../../../packages/bus/src/registry';
import { attestationReactor } from '../../../../../../packages/bus/src/reactors/attestation';
import { setVaultInternalApiKey } from '../../../../../../packages/auth/tests/support/internal-post-test-env';
import { seedOrgWithAssignedBot, seedRegisteredActor } from './seed-org-with-assigned-bot';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let client: PGlite;
let database: ReturnType<typeof drizzle>;
const nodeKeys = generateKeyPairSync('ed25519');
const tables = [identities, identityMembers, attestations, storedKeys, channelLinks, delegationGrants,
  profiles, connectors, orgConnectionMemberGrants, orgConnectionSuspensions, vaultDelegationGrants,
  vaultOwnerEnvelopes, registryApps, usageIncurred, orgConnectionEvents, transactions, balanceRollups];

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
  await client.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel; CREATE SCHEMA profile; CREATE SCHEMA registry; CREATE SCHEMA usage; CREATE SCHEMA pay;');
  for (const table of tables) await client.exec(tableSql(table));
  await client.exec(`
    CREATE UNIQUE INDEX seed_connector_slot ON kernel.connectors(owner_did,provider,slot);
    CREATE UNIQUE INDEX seed_owner_envelope ON kernel.vault_owner_envelopes(field,key_id);
    CREATE UNIQUE INDEX seed_custody ON kernel.vault_delegation_grants(subject,granted_to,field,key_id) WHERE status='active';
    CREATE UNIQUE INDEX seed_suspension ON kernel.org_connection_suspensions(org_did,member_did,provider,slot);
    CREATE UNIQUE INDEX seed_balance ON pay.balance_rollups(did,date,service);
  `);
  database = drizzle(client);
  h.db = database;
  vi.stubEnv('AUTH_PRIVATE_KEY', nodeKeys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'));
  vi.stubEnv('GROUP_KEY_ENCRYPTION_SECRET', randomUUID());
  vi.stubEnv('VAULT_OWNER_X_PUB', '');
  vi.stubEnv('VAULT_OWNER_ED_PUB', '');
  vi.stubEnv('NEXT_PUBLIC_DISABLE_INVITE_GATE', 'true');
  vi.stubEnv('AUTH_SERVICE_URL', 'https://kernel.test/auth');
  _resetSealingCache();
  h.nodeDid = getNodeSigningIdentity().senderDid;
  h.internalKey = randomUUID();
  provideInternalApiKey(h.internalKey);
  registerReactor('attestation', attestationReactor);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/apps/token/verify')) return verifyToken(new NextRequest(url, init));
    if (url.endsWith('/api/attestations/internal')) return internalAttestation(new NextRequest(url, init));
    // DFOS export is not required to verify the signed PostgreSQL receipt.
    if (url.endsWith('/api/attestations/chain-emit')) return Response.json({ emitted: true });
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
      h.upstreamCalls++;
      return Response.json({ data: [{ id: 'claude-scenario', display_name: 'Scenario model' }] });
    }
    if (url === 'https://api.anthropic.com/v1/messages') {
      h.upstreamCalls++;
      const key = new Headers(init?.headers).get('x-api-key') ?? '';
      expect(createHash('sha256').update(key).digest('hex')).toBe(h.expectedCredentialHash);
      return Response.json({ id: 'msg_scenario', content: [{ type: 'text', text: 'Scenario response' }],
        usage: { input_tokens: 3, output_tokens: 2 } });
    }
    throw new Error('Unexpected network request in isolated org-bot scenario');
  }));
});
afterEach(() => { h.log.mockClear(); });
afterAll(async () => {
  await client.close();
  setVaultInternalApiKey(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetSealingCache();
});

async function scenario(seal: Parameters<typeof seedOrgWithAssignedBot>[0]['seal'] = 'authenticated-org-route') {
  return seedOrgWithAssignedBot({ seal, authenticate: identity => { h.identity = identity; } });
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
async function callerRequest(seed: Scenario, path: string, actorDid = seed.botDid, actingAs: string | null = seed.orgDid) {
  const token = await createAppToken({
    azp: actorDid, sub: actorDid, scope: 'infer:completions', attestationId: randomUUID(),
  });
  return new NextRequest(`https://kernel.test/infer/v1/${path}`, {
    headers: { 'x-api-key': token, ...(actingAs ? { 'x-acting-as': actingAs } : {}) },
    ...(path === 'messages' ? { method: 'POST', body: JSON.stringify({
      model: 'claude-scenario', messages: [{ role: 'user', content: 'Scenario prompt' }], max_tokens: 8,
    }) } : {}),
  });
}
async function discover(seed: Scenario, actorDid = seed.botDid) {
  return usableModels(await callerRequest(seed, 'models/usable', actorDid));
}
async function infer(seed: Scenario, actorDid = seed.botDid) {
  h.expectedCredentialHash = seed.credentialHash;
  return messages(await callerRequest(seed, 'messages', actorDid));
}
async function connection(seed: Scenario) {
  const [row] = await database.select().from(connectors).where(eq(connectors.ownerDid, seed.orgDid));
  return row;
}
async function deniedOnBoth(seed: Scenario, status: number, error: string, actorDid = seed.botDid) {
  const calls = h.upstreamCalls;
  const usage = await database.select().from(usageIncurred);
  for (const response of [await discover(seed, actorDid), await infer(seed, actorDid)]) {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining(error) });
  }
  expect(h.upstreamCalls).toBe(calls);
  expect(await database.select().from(usageIncurred)).toEqual(usage);
}
/** Adversarial corruption is a state change with signed history, not fixture insertion. */
async function corrupt(seed: Scenario, target: 'connector' | 'custody', changes: Record<string, unknown>) {
  const evidence = await prepareMechanicalAttestation({
    type: 'connector.org-held', subjectDid: seed.orgDid, contextId: seed.orgDid, contextType: 'test-corruption',
    payload: { target, changedFields: Object.keys(changes), reason: 'Negative boundary scenario' },
  });
  await database.transaction(async tx => {
    if (target === 'connector') await tx.update(connectors).set(changes).where(eq(connectors.ownerDid, seed.orgDid));
    else await tx.update(vaultDelegationGrants).set(changes).where(eq(vaultDelegationGrants.field, seed.field));
    await tx.insert(attestations).values(evidence);
  });
}

describe('assigned org-bot discovery seeded by real writers (#3335)', () => {
  it('refuses the legacy node-self-granted row and directs an admin to re-seal without backfilling provenance', async () => {
    const seed = await scenario('legacy-token-paste');
    const [connection] = await database.select().from(connectors).where(eq(connectors.ownerDid, seed.orgDid));
    const [custody] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.field, seed.field));
    expect(connection).toMatchObject({
      provider: 'anthropic', slot: 'primary', status: 'active', sealedKeyField: seed.field, orgContextDid: null,
    });
    expect(custody).toMatchObject({ subject: h.nodeDid, grantedTo: h.nodeDid, status: 'active', oneTime: false });
    expect(hasOrgConnectionProvenance(connection)).toBe(false);
    await deniedOnBoth(seed, 403, 're-seal through the org connectors page');
    expect(await database.select().from(connectors).where(eq(connectors.ownerDid, seed.orgDid))).toEqual([connection]);
    await expect(requireOrgConnectionMemberGrant({
      memberDid: seed.humanDid, orgDid: seed.orgDid, actingDid: seed.orgDid, provider: 'anthropic',
    })).rejects.toMatchObject({ status: 403, code: 'connection_not_loaded',
      message: expect.stringContaining('re-seal through the org connectors page') });
  });

  it('records the current authenticated org-route writer shape without hand-written fixture rows', async () => {
    const seed = await scenario('authenticated-org-route');
    const [connection] = await database.select().from(connectors).where(eq(connectors.ownerDid, seed.orgDid));
    const [custody] = await database.select().from(vaultDelegationGrants).where(eq(vaultDelegationGrants.field, seed.field));
    expect(connection).toMatchObject({ loadedByDid: seed.humanDid, loadedAt: expect.any(Date) });
    expect(custody).toMatchObject({ subject: seed.orgDid, grantedTo: h.nodeDid, status: 'active', oneTime: false });
    const response = await discover(seed);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(await response.json()).toMatchObject({ data: [expect.objectContaining({
      id: 'claude-scenario', imajin: expect.objectContaining({ credentialDid: seed.orgDid }),
    })] });
    expect(await database.select().from(orgConnectionMemberGrants)).toEqual([]);
  });

  it('resolves the org brain and writes a real signed usage receipt with the agent actor and org bill', async () => {
    const seed = await scenario();
    const brain = await resolveBrain({ caller: { actorDid: seed.botDid, actingAs: seed.orgDid } }, {
      connectors: ['anthropic'], model: 'claude-scenario',
    });
    expect(createHash('sha256').update(brain.apiKey).digest('hex')).toBe(seed.credentialHash);
    expect(brain).toMatchObject({ actorDid: seed.botDid, credentialDid: seed.orgDid, provider: 'anthropic',
      orgUsage: { orgDid: seed.orgDid, memberDid: seed.orgDid, connectionId: (await connection(seed)).id } });
    expect((await infer(seed)).status).toBe(200);
    const [usage] = await database.select().from(usageIncurred).where(eq(usageIncurred.principalDid, seed.orgDid));
    expect(usage).toMatchObject({ agentDid: seed.botDid, provider: 'anthropic', model: 'claude-scenario', tokensIn: 3, tokensOut: 2 });
    await vi.waitFor(async () => {
      const [receipt] = await database.select().from(attestations).where(and(
        eq(attestations.type, 'usage.incurred'), eq(attestations.contextId, usage.id),
      ));
      expect(receipt).toMatchObject({ issuerDid: h.nodeDid, subjectDid: seed.orgDid,
        payload: expect.objectContaining({ agentDid: seed.botDid, actingFor: seed.orgDid, usageId: usage.id,
          metadata: expect.objectContaining({ orgDid: seed.orgDid }) }) });
      expect(crypto.verifySync(receipt.signature, canonicalize({
        subject_did: receipt.subjectDid, type: receipt.type, context_id: receipt.contextId,
        context_type: receipt.contextType, payload: receipt.payload, issued_at: receipt.issuedAt.getTime(),
      }), getNodeSigningIdentity().senderPubkey)).toBe(true);
    });
  });

  it('refuses an unassigned agent before custody or upstream access', async () => {
    const seed = await seedOrgWithAssignedBot({ authenticate: identity => { h.identity = identity; }, assigned: false });
    await deniedOnBoth(seed, 403, 'Not authorized to act as this group');
  });

  it('refuses revoked vault custody on the next call, with its signed revocation retained', async () => {
    const seed = await scenario();
    expect((await discover(seed)).status).toBe(200);
    expect(await revokeVaultDelegationGrantsForConnector('anthropic', seed.orgDid, { attest: true })).toBe(1);
    await deniedOnBoth(seed, 503, 'Organization inference credential unavailable');
    expect(await database.select().from(attestations).where(and(
      eq(attestations.subjectDid, seed.orgDid), eq(attestations.type, 'delegation.grant.revoked'),
    ))).toHaveLength(1);
  });

  it('refuses custody granted to another node on the next call', async () => {
    const seed = await scenario();
    expect((await discover(seed)).status).toBe(200);
    await corrupt(seed, 'custody', { grantedTo: 'did:imajin:another-node' });
    await deniedOnBoth(seed, 503, 'Organization inference credential unavailable');
  });

  it('refuses another org field even when its real custody and connector are active', async () => {
    const seed = await scenario();
    const other = await scenario();
    await corrupt(seed, 'connector', { sealedKeyField: other.field });
    await deniedOnBoth(seed, 403, 'No active connection');
    expect((await discover(other)).status).toBe(200);
  });

  it('refuses an admin-suspended org connection immediately and retains the signed policy history', async () => {
    const seed = await scenario();
    expect((await discover(seed)).status).toBe(200);
    await changeOrgConnection({ effectiveDid: seed.orgDid, actingHumanDid: seed.humanDid }, {
      action: 'suspend', provider: 'anthropic', reason: 'Scenario admin suspension',
    });
    await deniedOnBoth(seed, 403, 'No active personal external MCP connection or grant');
    expect(await database.select().from(orgConnectionEvents).where(eq(orgConnectionEvents.orgDid, seed.orgDid))).toHaveLength(1);
  });

  it('refuses a non-member human acting as the org', async () => {
    const seed = await scenario();
    const outsider = await seedRegisteredActor('human');
    await deniedOnBoth(seed, 403, 'Not authorized to act as this group', outsider.did);
  });

  it('requires a specific human member grant and refuses it immediately after real revocation', async () => {
    const seed = await scenario();
    await deniedOnBoth(seed, 403, 'Active org-connection member grant required', seed.humanDid);
    const actor = { orgDid: seed.orgDid, actorDid: seed.humanDid };
    const input = { memberDid: seed.humanDid, reason: 'Scenario per-member authorization' };
    await changeOrgConnectionMemberGrant(actor, 'anthropic', input, 'grant');
    expect((await discover(seed, seed.humanDid)).status).toBe(200);
    await changeOrgConnectionMemberGrant(actor, 'anthropic', input, 'revoke');
    await deniedOnBoth(seed, 403, 'Active org-connection member grant required', seed.humanDid);
  });

  it.each(['loadedByDid', 'loadedAt'] as const)('refuses missing %s without weakening the provenance boundary', async field => {
    const seed = await scenario();
    await corrupt(seed, 'connector', { [field]: null });
    await deniedOnBoth(seed, 403, 're-seal through the org connectors page');
  });

  it('keeps the same agent on its own identity without an org selector', async () => {
    const seed = await scenario();
    const response = await usableModels(await callerRequest(seed, 'models/usable', seed.botDid, null));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [] });
    expect((await discover(seed)).status).toBe(200);
  });
});
