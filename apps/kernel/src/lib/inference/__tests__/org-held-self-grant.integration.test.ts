import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import type { Identity } from '@imajin/auth';
import type { VaultFile } from '@imajin/vault-core';

const h = vi.hoisted(() => ({
  db: null as unknown, identity: {} as Identity, vault: { version: 1, entries: [] } as VaultFile,
  log: vi.fn(), usage: vi.fn(), personal: vi.fn(), fallback: vi.fn(), fetch: vi.fn(),
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'), ...await import('@/src/db/schemas/connectors'),
  ...await import('@/src/db/schemas/vault'), ...await import('@/src/db/schemas/registry'),
  get db() { return h.db; },
}));
vi.mock('@imajin/auth', async original => ({
  ...await original<typeof import('@imajin/auth')>(),
  requireAppAuth: vi.fn(async () => ({ error: 'Not an app token', status: 401, notAppToken: true })),
  requireAuth: vi.fn(async () => ({ identity: h.identity })),
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ debug: h.log, info: h.log, warn: h.log, error: h.log }) }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/vault/vault-repository', () => ({
  getVaultRepository: () => ({
    load: async () => structuredClone(h.vault),
    save: async (vault: VaultFile) => { h.vault = structuredClone(vault); },
  }),
}));
vi.mock('@/src/lib/inference/usage-ledger', () => ({ recordInferenceUsage: h.usage }));
vi.mock('@/src/lib/inference/spend-cap', () => ({ enforceSpendCap: vi.fn(), SpendCapExceededError: class extends Error {} }));
vi.mock('@/src/lib/kernel/app-registrant', () => ({ lookupAppRegistrantDid: h.fallback }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  readConnectorRegistration: vi.fn().mockResolvedValue(undefined), connectorRegistryId: () => 'connector-fixture',
  listConnectorRegistrations: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/src/lib/anthropic/connector', () => ({
  loadAnthropicCredentials: h.personal, ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
}));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: vi.fn() }));
vi.mock('@imajin/config', async original => ({
  ...await original<typeof import('@imajin/config')>(), rateLimit: () => ({ limited: false }), getClientIP: () => '127.0.0.1',
}));

import { generateKeypair } from '@imajin/auth';
import { identities, identityMembers, delegationGrants, channelLinks } from '@/src/db/schemas/auth';
import { connectors, orgConnectionMemberGrants, orgConnectionSuspensions } from '@/src/db/schemas/connectors';
import { vaultDelegationGrants, vaultOwnerEnvelopes } from '@/src/db/schemas/vault';
import { sealAndStoreV2 } from '@/src/lib/vault';
import { getNodeSigningIdentity, _resetSealingCache } from '@/src/lib/vault/sealing';
import { findNodeCustodyGrant } from '@/src/lib/vault/node-custody-grant';
import { nodeCustodyGrantFixture } from '@/src/lib/vault/__tests__/node-custody-fixture';
import { GET as usableModels } from '@/app/infer/v1/models/usable/route';
import { POST as infer } from '@/app/infer/v1/messages/route';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const tables = [identities, identityMembers, delegationGrants, channelLinks, connectors,
  orgConnectionMemberGrants, orgConnectionSuspensions, vaultDelegationGrants, vaultOwnerEnvelopes];
const keys = generateKeypair();
let client: PGlite;
let database: ReturnType<typeof drizzle>;
let sequence = 0;
let orgDid: string;
let agentDid: string;
let field: string;
let value: string;
let grantId: string;

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel;');
  for (const table of tables) {
    const { schema, name, columns } = getTableConfig(table);
    const fields = columns.map(column => {
      let fallback = '';
      if (['created_at', 'updated_at', 'issued_at'].includes(column.name)) fallback = ' DEFAULT now()';
      else if (typeof column.default === 'string') fallback = ` DEFAULT '${column.default}'`;
      else if (typeof column.default === 'boolean') fallback = ` DEFAULT ${column.default}`;
      return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${fallback}`;
    });
    await client.exec(`CREATE TABLE "${schema}"."${name}" (${fields.join(',')})`);
  }
  await client.exec('CREATE UNIQUE INDEX owner_envelope ON kernel.vault_owner_envelopes(field,key_id)');
  database = drizzle(client);
  h.db = database;
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey);
  vi.stubEnv('VAULT_OWNER_X_PUB', '');
  vi.stubEnv('VAULT_OWNER_ED_PUB', '');
  _resetSealingCache();
  sequence++;
  orgDid = `did:imajin:selfgrantorg${sequence}`;
  agentDid = `did:imajin:selfgrantagent${sequence}`;
  field = `anthropic-api-key:${orgDid}`;
  value = randomBytes(32).toString('hex');
  h.vault = { version: 1, entries: [] };
  h.identity = { id: agentDid, scope: 'actor', subtype: 'agent', actingAs: orgDid };
  await database.insert(identities).values([
    { id: orgDid, scope: 'business', publicKey: keys.publicKey },
    { id: agentDid, scope: 'actor', subtype: 'agent', publicKey: keys.publicKey },
  ]);
  await database.insert(identityMembers).values({
    identityDid: orgDid, memberDid: agentDid, role: 'agent', allowedServices: ['infer'],
  });
  const sealed = await sealAndStoreV2(field, value);
  grantId = sealed.grantId!;
  await database.insert(connectors).values({
    id: `selfgrant-connection-${sequence}`, ownerDid: orgDid, provider: 'anthropic', slot: 'primary',
    status: 'active', sealedKeyField: field, loadedByDid: `did:imajin:loader${sequence}`, loadedAt: new Date(),
  });
  vi.stubGlobal('fetch', h.fetch);
  h.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('x-api-key') === value, 'Only org credential is injected').toBe(true);
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'claude-self-grant', display_name: 'Fixture model' }] });
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    return Response.json({ id: 'msg_fixture', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); _resetSealingCache(); });
afterAll(async () => { await client.close(); });

function request(listing = false) {
  return new NextRequest(`https://kernel.test/infer/v1/${listing ? 'models/usable' : 'messages'}`, {
    ...(listing ? {} : { method: 'POST', body: JSON.stringify({ model: 'claude-self-grant', max_tokens: 8, messages: [] }) }),
  });
}
async function assertPrivate(response: Response) {
  expect(await response.clone().text()).not.toContain(value);
  expect(JSON.stringify([...response.headers])).not.toContain(value);
  expect(JSON.stringify([h.log.mock.calls, h.usage.mock.calls, h.vault])).not.toContain(value);
  expect(h.personal).not.toHaveBeenCalled();
  expect(h.fallback).not.toHaveBeenCalled();
}

describe('real sealAndStoreV2 self-grant → assigned org bot (#3331)', () => {
  it('matches the canonical fixture pair and serves usable models and inference without a member grant', async () => {
    const grant = await database.transaction(tx => findNodeCustodyGrant({ field, ownerDid: orgDid, tx }));
    const fixture = nodeCustodyGrantFixture(field, getNodeSigningIdentity().senderDid);
    expect(grant?.id).toBe(grantId);
    expect(grant?.subject).toBe(fixture.subject);
    expect(grant?.grantedTo).toBe(fixture.grantedTo);
    expect(await database.select().from(orgConnectionMemberGrants)).toEqual([]);
    const listing = await usableModels(request(true));
    expect(listing.status, await listing.clone().text()).toBe(200);
    expect((await listing.clone().json()).data).toEqual([expect.objectContaining({
      id: 'claude-self-grant', imajin: expect.objectContaining({ credentialDid: orgDid }),
    })]);
    const response = await infer(request());
    expect(response.status).toBe(200);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.usage).toHaveBeenCalledWith(expect.objectContaining({ principalDid: orgDid, agentDid }));
    await assertPrivate(listing);
    await assertPrivate(response);
  });

  it.each(['wrong-field', 'foreign-grantee', 'revoked', 'revoked-at', 'oneTime', 'expired', 'foreign-subject'] as const)(
    'refuses %s custody in both routes before any provider dispatch', async boundary => {
      const changes: Partial<typeof vaultDelegationGrants.$inferInsert> = {
        ...boundary === 'wrong-field' ? { field: 'anthropic-api-key:did:imajin:anotherorg' } : {},
        ...boundary === 'foreign-grantee' ? { grantedTo: 'did:imajin:anothernode' } : {},
        ...boundary === 'revoked' ? { status: 'revoked' } : {},
        ...boundary === 'revoked-at' ? { revokedAt: new Date() } : {},
        ...boundary === 'oneTime' ? { oneTime: true } : {},
        ...boundary === 'expired' ? { expiresAt: new Date(0) } : {},
      };
      if (boundary === 'foreign-subject') changes.subject = 'did:imajin:anotherowner';
      await database.update(vaultDelegationGrants).set(changes).where(eq(vaultDelegationGrants.id, grantId));
      for (const response of [await usableModels(request(true)), await infer(request())]) {
        expect(response.status).toBe(503);
        await assertPrivate(response);
      }
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.usage).not.toHaveBeenCalled();
    },
  );

  it('requires the connector field to belong to this org even when a live self-grant exists for another org', async () => {
    const foreignField = 'anthropic-api-key:did:imajin:anotherorg';
    await sealAndStoreV2(foreignField, randomBytes(32).toString('hex'));
    await database.update(connectors).set({ sealedKeyField: foreignField }).where(eq(connectors.ownerDid, orgDid));
    for (const response of [await usableModels(request(true)), await infer(request())]) {
      expect(response.status).toBe(403);
      await assertPrivate(response);
    }
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('supports legacy owner-subject custody with the same mandatory field, node and active filters', async () => {
    const legacy = { ...nodeCustodyGrantFixture(field, getNodeSigningIdentity().senderDid) };
    legacy.subject = orgDid;
    await database.update(vaultDelegationGrants).set({ ...legacy, id: grantId }).where(eq(vaultDelegationGrants.id, grantId));
    const grant = await database.transaction(tx => findNodeCustodyGrant({ field, ownerDid: orgDid, tx, lock: true }));
    expect(grant?.id).toBe(grantId);
    expect(await database.transaction(tx => findNodeCustodyGrant({ field, ownerDid: 'did:imajin:otherorg', tx }))).toBeUndefined();
  });
});
