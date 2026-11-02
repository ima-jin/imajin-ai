import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  db: null as unknown, key: '', get: vi.fn(), unseal: vi.fn(), usage: vi.fn(),
  log: vi.fn(), personal: vi.fn(), fallback: vi.fn(), session: vi.fn(), deniedScope: false,
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'), ...await import('@/src/db/schemas/connectors'),
  ...await import('@/src/db/schemas/vault'), ...await import('@/src/db/schemas/registry'),
  get db() { return h.db; },
}));
vi.mock('@/src/lib/vault', () => ({
  vaultService: { get: h.get }, _applyDelegationGrant: h.unseal,
}));
vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({ senderDid: 'did:imajin:node', senderPubkey: 'node-public' }),
  getNodeXPrivateKey: () => new Uint8Array(32),
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: h.log, warn: h.log, error: h.log }) }));
vi.mock('@imajin/auth', async original => ({
  ...await original<typeof import('@imajin/auth')>(), requireAuth: h.session,
}));
vi.mock('@/src/lib/inference/usage-ledger', () => ({ recordInferenceUsage: h.usage }));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({ prepareMechanicalAttestation: vi.fn() }));
vi.mock('@/src/lib/inference/spend-cap', () => ({ enforceSpendCap: vi.fn(), SpendCapExceededError: class extends Error {} }));
vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  readConnectorRegistration: vi.fn().mockResolvedValue(undefined), connectorRegistryId: () => 'connector-fixture',
}));
vi.mock('@/src/lib/kernel/app-registrant', () => ({ lookupAppRegistrantDid: h.fallback }));
vi.mock('@/src/lib/anthropic/connector', () => ({ loadAnthropicCredentials: h.personal }));
vi.mock('@/src/lib/inference/model-catalog', () => ({ expandUsableModels: vi.fn(), resolvePickerModel: vi.fn() }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: vi.fn() }));
vi.mock('@imajin/config', async original => ({
  ...await original<typeof import('@imajin/config')>(), rateLimit: () => ({ limited: false }), getClientIP: () => '127.0.0.1',
}));

import { identities, identityMembers } from '@/src/db/schemas/auth';
import { connectors, orgConnectionMemberGrants, orgConnectionSuspensions } from '@/src/db/schemas/connectors';
import { vaultDelegationGrants } from '@/src/db/schemas/vault';
import { provideInternalApiKey } from '@imajin/auth';
import { setVaultInternalApiKey } from '../../../../../../packages/auth/tests/support/internal-post-test-env';
import { EXTERNAL_MCP_NAMESPACE } from '@/src/lib/vault/field-grammar';
import { POST } from '@/app/infer/v1/messages/route';
import { POST as countTokens } from '@/app/infer/v1/messages/count_tokens/route';
import { GET as models } from '@/app/infer/v1/models/route';
import { resolveOrgHeldBrain } from '../org-held-brain';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const MEMBER = 'did:imajin:member';
const ORG = 'did:imajin:artifact';
const APP = 'did:imajin:app';
const FIELD = `${EXTERNAL_MCP_NAMESPACE}:org-fixture:${ORG}`;
const tables = [identities, identityMembers, connectors, orgConnectionMemberGrants, orgConnectionSuspensions, vaultDelegationGrants];
let client: PGlite;
let database: ReturnType<typeof drizzle>;
let upstreamCalls = 0;

function request(body: unknown = { model: 'claude-test', messages: [], max_tokens: 8 }, org: string | null = ORG) {
  return new NextRequest('https://kernel.test/infer/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 'fixture-app-token', ...(org ? { 'x-acting-as': org } : {}) },
    body: JSON.stringify(body),
  });
}
async function assertPrivate(response: Response) {
  expect(await response.clone().text()).not.toContain(h.key);
  expect(JSON.stringify([...response.headers])).not.toContain(h.key);
  expect(JSON.stringify(h.log.mock.calls)).not.toContain(h.key);
  expect(JSON.stringify(h.usage.mock.calls)).not.toContain(h.key);
  expect(JSON.stringify(h.usage.mock.calls)).not.toContain(FIELD);
}
async function denyNext() {
  h.get.mockClear();
  h.unseal.mockClear();
  const before = upstreamCalls;
  const response = await POST(request());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'Active org-connection member grant required for anthropic' });
  expect(h.get).not.toHaveBeenCalled();
  expect(h.unseal).not.toHaveBeenCalled();
  expect(h.personal).not.toHaveBeenCalled();
  expect(h.fallback).not.toHaveBeenCalled();
  expect(upstreamCalls).toBe(before);
}

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel;');
  // Exact schema column names/types; no external PostgreSQL server or credentials.
  for (const table of tables) {
    const { schema, name, columns } = getTableConfig(table);
    const fields = columns.map(column => `"${column.name}" ${column.getSQLType()}`).join(',');
    await client.exec(`CREATE TABLE "${schema}"."${name}" (${fields})`);
  }
  database = drizzle(client);
  h.db = database;
});
afterAll(async () => { await client.close(); });
afterEach(() => { setVaultInternalApiKey(undefined); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await client.exec('TRUNCATE auth.identities, auth.identity_members, kernel.connectors, kernel.org_connection_member_grants, kernel.org_connection_suspensions, kernel.vault_delegation_grants');
  vi.clearAllMocks();
  h.key = randomUUID();
  upstreamCalls = 0;
  h.deniedScope = false;
  h.session.mockResolvedValue({ error: 'No session', status: 401 });
  h.get.mockResolvedValue({ senderPubkey: 'node-public', custodyScheme: 'delegation-grant' });
  h.unseal.mockImplementation(async () => h.key);
  h.usage.mockResolvedValue(undefined);
  h.personal.mockResolvedValue({ apiKey: randomUUID(), modelId: 'personal-model' });
  provideInternalApiKey(randomUUID());
  vi.stubEnv('AUTH_SERVICE_URL', 'https://auth.test/auth');
  await database.insert(identities).values([
    { id: MEMBER, publicKey: 'member-public', scope: 'actor', subtype: 'human' },
    { id: ORG, publicKey: 'org-public', scope: 'business' },
  ]);
  await database.insert(identityMembers).values({ identityDid: ORG, memberDid: MEMBER, role: 'agent' });
  await database.insert(connectors).values({
    id: 'org-connection', ownerDid: ORG, provider: 'org-held-anthropic', slot: 'primary',
    status: 'active', sealedKeyField: FIELD, loadedByDid: MEMBER, loadedAt: new Date(),
  });
  await database.insert(orgConnectionMemberGrants).values({
    id: 'member-grant', orgDid: ORG, memberDid: MEMBER, connectionId: 'org-connection',
    provider: 'anthropic', grantedAt: new Date(), grantedByDid: MEMBER,
  });
  await database.insert(vaultDelegationGrants).values({
    id: 'custody', field: FIELD, subject: ORG, grantedTo: 'did:imajin:node', status: 'active', oneTime: false,
    ownerXPub: 'fixture', wrappedKey: 'fixture', wrappedNonce: 'fixture', keyId: 'fixture', ownerSignature: 'fixture',
  });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/api/apps/token/verify')) {
      return h.deniedScope ? Response.json({ error: 'Scope not granted' }, { status: 403 })
        : Response.json({ appDid: APP, userDid: MEMBER, scopes: ['infer:completions'], attestationId: 'app-grant' });
    }
    if (input.includes('/controllers/')) return Response.json({ valid: true, role: 'agent' });
    expect(input.startsWith('https://api.anthropic.com/v1/')).toBe(true);
    upstreamCalls++;
    expect(new Headers(init?.headers).get('x-api-key')).toBe(h.key);
    return Response.json({ id: 'msg_test', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 3, output_tokens: 2 } });
  }));
});

describe('org-held Anthropic inference through real auth, grant SQL and route', () => {
  it('injects only server-side and attributes usage to the member with allowlisted org provenance', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(h.unseal).toHaveBeenCalledTimes(1);
    expect(h.usage).toHaveBeenCalledWith(expect.objectContaining({
      principalDid: MEMBER, agentDid: APP,
      metadata: { orgDid: ORG, grantId: 'member-grant', connectionId: 'org-connection', format: 'anthropic-messages' },
    }));
    expect(h.personal).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
    await assertPrivate(response);
  });
  it.each(['revoked-grant', 'removed-member', 'suspended-member', 'suspended-org', 'revoked-connection', 'suspension'])(
    'denies the very next call after %s without any cached grant/key or fallback', async boundary => {
      expect((await POST(request())).status).toBe(200);
      if (boundary === 'revoked-grant') await database.update(orgConnectionMemberGrants).set({ revokedAt: new Date() });
      if (boundary === 'removed-member') await database.update(identityMembers).set({ removedAt: new Date() });
      if (boundary === 'suspended-member') await database.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, MEMBER));
      if (boundary === 'suspended-org') await database.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, ORG));
      if (boundary === 'revoked-connection') await database.update(connectors).set({ revokedAt: new Date() });
      if (boundary === 'suspension') await database.insert(orgConnectionSuspensions).values({
        orgDid: ORG, memberDid: MEMBER, provider: 'anthropic', slot: '', suspendedAt: new Date(),
      });
      await denyNext();
    },
  );
  it('denies absent grants and agent-identity grantees using the unchanged grant contract', async () => {
    await database.update(orgConnectionMemberGrants).set({ revokedAt: new Date() });
    await denyNext();
    await database.update(orgConnectionMemberGrants).set({ revokedAt: null });
    await database.update(identities).set({ subtype: 'agent' }).where(eq(identities.id, MEMBER));
    await denyNext();
  });
  it('checks app scope before reading custody and never falls back to session', async () => {
    h.deniedScope = true;
    expect((await POST(request())).status).toBe(403);
    expect(h.get).not.toHaveBeenCalled();
    expect(h.session).not.toHaveBeenCalled();
  });
  it.each(['revoked', 'expired', 'one-time', 'missing-entry', 'deleted-entry', 'wrong-sender', 'wrong-scheme', 'unseal-error'])(
    'refuses invalid custody (%s), without leaking errors or trying another key', async boundary => {
      if (boundary === 'revoked') await database.update(vaultDelegationGrants).set({ revokedAt: new Date() });
      if (boundary === 'expired') await database.update(vaultDelegationGrants).set({ expiresAt: new Date(0) });
      if (boundary === 'one-time') await database.update(vaultDelegationGrants).set({ oneTime: true });
      if (boundary === 'missing-entry') h.get.mockResolvedValue(null);
      if (boundary === 'deleted-entry') h.get.mockResolvedValue({ deleted: true });
      if (boundary === 'wrong-sender') h.get.mockResolvedValue({ senderPubkey: 'other', custodyScheme: 'delegation-grant' });
      if (boundary === 'wrong-scheme') h.get.mockResolvedValue({ senderPubkey: 'node-public', custodyScheme: 'other' });
      if (boundary === 'unseal-error') h.unseal.mockImplementation(async () => { throw new Error(h.key); });
      const response = await POST(request());
      expect(response.status).toBe(503);
      await assertPrivate(response);
      expect(h.personal).not.toHaveBeenCalled();
      expect(upstreamCalls).toBe(0);
    },
  );
  it('protects count_tokens and model listing with the same live grant', async () => {
    expect((await countTokens(request())).status).toBe(200);
    expect((await models(request())).status).toBe(200);
    await database.update(orgConnectionMemberGrants).set({ revokedAt: new Date() });
    expect((await countTokens(request())).status).toBe(403);
    expect((await models(request())).status).toBe(403);
  });
  it('requires a model for org messages rather than selecting a personal card', async () => {
    expect((await POST(request({ messages: [] }))).status).toBe(400);
    expect(upstreamCalls).toBe(0);
  });
  it('returns safe provenance only alongside the internal key', async () => {
    const brain = await resolveOrgHeldBrain({ memberDid: MEMBER, orgDid: ORG }, 'claude-test');
    expect(brain.apiKey).toBe(h.key);
    expect(brain.orgUsage).toEqual({ memberDid: MEMBER, orgDid: ORG, grantId: 'member-grant', connectionId: 'org-connection' });
    expect(JSON.stringify(brain)).not.toContain(FIELD);
  });
});
