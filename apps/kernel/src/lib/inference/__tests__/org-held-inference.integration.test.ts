import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  db: null as unknown, key: '', get: vi.fn(), unseal: vi.fn(), usage: vi.fn(),
  log: vi.fn(), personal: vi.fn(), fallback: vi.fn(), session: vi.fn(), deniedScope: false, upstreamMode: 'normal',
  tokenDid: '',
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
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@/src/lib/anthropic/connector', () => ({
  loadAnthropicCredentials: h.personal, ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
}));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: vi.fn() }));
vi.mock('@imajin/config', async original => ({
  ...await original<typeof import('@imajin/config')>(), rateLimit: () => ({ limited: false }), getClientIP: () => '127.0.0.1',
}));

import { delegationGrants, identities, identityMembers } from '@/src/db/schemas/auth';
import { connectors, orgConnectionMemberGrants, orgConnectionSuspensions } from '@/src/db/schemas/connectors';
import { vaultDelegationGrants } from '@/src/db/schemas/vault';
import { provideInternalApiKey, provideSessionResolver } from '@imajin/auth';
import { SESSION_COOKIE_NAME } from '@imajin/config';
import { requireAuth as requireSessionAuth } from '../../../../../../packages/auth/src/require-auth';
import { setVaultInternalApiKey } from '../../../../../../packages/auth/tests/support/internal-post-test-env';
import { EXTERNAL_MCP_NAMESPACE } from '@/src/lib/vault/field-grammar';
import { POST } from '@/app/infer/v1/messages/route';
import { POST as countTokens } from '@/app/infer/v1/messages/count_tokens/route';
import { GET as models } from '@/app/infer/v1/models/route';
import { GET as usableModels } from '@/app/infer/v1/models/usable/route';
import { resolveOrgHeldBrain } from '../org-held-brain';
import { resolveBrain } from '../brain';
import { authorizeExternalMcp } from '@/src/lib/kernel/external-mcp';
import { GET as warpRuns } from '@/app/warp/api/runs/route';
import { resolveAgentAuthority } from '@/src/lib/auth/agent-authority';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const MEMBER = 'did:imajin:member';
const ORG = 'did:imajin:artifact';
const APP = 'did:imajin:app';
const AGENT = 'did:imajin:agent';
const FIELD = `${EXTERNAL_MCP_NAMESPACE}:org-fixture:${ORG}`;
const tables = [identities, identityMembers, delegationGrants, connectors, orgConnectionMemberGrants, orgConnectionSuspensions, vaultDelegationGrants];
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
async function denyNext(grantError = true) {
  h.get.mockClear();
  h.unseal.mockClear();
  const before = upstreamCalls;
  const response = await POST(request());
  expect(response.status).toBe(403);
  const body = await response.json();
  expect(typeof body.error).toBe('string');
  if (grantError) expect(body.error).toContain('/auth/connectors');
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

describe('assigned agents use only the assigned DID keys, without member-grant rows', () => {
  async function assign(principal = ORG, allowedServices: string[] | null = null) {
    await database.insert(identityMembers).values({
      identityDid: principal, memberDid: AGENT, role: 'agent', allowedServices,
    });
  }
  function agentSession(actingAs?: string, actingFor?: string) {
    h.session.mockResolvedValue({ identity: { id: AGENT, scope: 'actor', subtype: 'agent', actingAs, actingFor } });
    return new NextRequest('https://kernel.test/infer/v1/messages', {
      method: 'POST', body: JSON.stringify({ model: 'claude-test', messages: [], max_tokens: 8 }),
    });
  }
  it('uses the org key and bills the org with the signing agent as actor', async () => {
    await assign();
    expect(await database.select().from(orgConnectionMemberGrants)).toEqual([]);
    h.tokenDid = AGENT;
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(h.usage).toHaveBeenCalledWith(expect.objectContaining({ principalDid: ORG, agentDid: AGENT }));
    expect(h.personal).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
    await assertPrivate(response);
  });
  it('refuses a missing assigned org connection without using personal credentials', async () => {
    await assign();
    await database.update(connectors).set({ status: 'revoked', revokedAt: new Date() });
    const response = await POST(agentSession(ORG));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain(ORG);
    expect(h.personal).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  });
  it('refuses an excluded inference provider before org custody access', async () => {
    await assign();
    await expect(resolveBrain({ caller: { actorDid: AGENT, actingAs: ORG } }, { connectors: ['openai'] }))
      .rejects.toMatchObject({ status: 403 });
    expect(h.get).not.toHaveBeenCalled();
  });
  it('requires an active human member grant through the actual Warp tool route', async () => {
    await database.update(connectors).set({ provider: 'org-held-warp' });
    const req = () => new NextRequest('https://kernel.test/warp/api/runs', {
      headers: { authorization: 'Bearer fixture-app-token', 'x-acting-as': ORG },
    });
    expect((await warpRuns(req())).status).toBe(403);
    await database.insert(orgConnectionMemberGrants).values({
      id: 'warp-member-grant', orgDid: ORG, memberDid: MEMBER, connectionId: 'org-connection',
      provider: 'warp', grantedAt: new Date(), grantedByDid: MEMBER,
    });
    expect((await warpRuns(req())).status).toBe(200);
    await database.update(orgConnectionMemberGrants).set({ revokedAt: new Date() });
    const response = await warpRuns(req());
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('/auth/connectors');
    expect(upstreamCalls).toBe(1);
  });
  it('accepts an active delegation from the target DID without an identity membership', async () => {
    await database.insert(delegationGrants).values({
      id: 'assignment', agentDid: AGENT, delegatorDid: ORG, audience: { type: 'all' },
      issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), status: 'active',
    });
    h.tokenDid = AGENT;
    expect((await POST(request())).status).toBe(200);
    await database.update(delegationGrants).set({ revokedAt: new Date(), status: 'revoked' });
    expect((await POST(request())).status).toBe(403);
  });
  it('uses a human principal key onBehalfOf that human, not the org or agent key', async () => {
    await assign(MEMBER);
    h.personal.mockImplementation(async did => did === MEMBER ? { apiKey: h.key, modelId: 'personal-model' } : undefined);
    const brain = await resolveBrain({ appDid: APP, caller: { actorDid: AGENT, actingFor: MEMBER } }, { connectors: ['anthropic'] });
    expect(brain).toMatchObject({ apiKey: h.key, credentialDid: MEMBER, actorDid: AGENT });
    expect(h.personal.mock.calls).toEqual([[MEMBER]]);
    expect(h.fallback).not.toHaveBeenCalled();
  });
  it('uses only its own key when acting as itself, even when assigned to an org', async () => {
    await assign();
    const brain = await resolveBrain({ appDid: APP, caller: { actorDid: AGENT } }, { connectors: ['anthropic'] });
    expect(brain.credentialDid).toBe(AGENT);
    expect(h.personal.mock.calls).toEqual([[AGENT]]);
    expect(h.get).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  });
  it.each(['unassigned', 'removed', 'wrong-role', 'excluded-service', 'empty-services'])(
    'refuses %s agents before unsealing, without fallback', async boundary => {
      if (boundary !== 'unassigned') await assign();
      if (boundary === 'removed') await database.update(identityMembers).set({ removedAt: new Date() }).where(eq(identityMembers.memberDid, AGENT));
      if (boundary === 'wrong-role') await database.update(identityMembers).set({ role: 'member' }).where(eq(identityMembers.memberDid, AGENT));
      if (boundary === 'excluded-service' || boundary === 'empty-services') {
        await database.update(identityMembers).set({ allowedServices: boundary === 'empty-services' ? [] : ['pay'] })
          .where(eq(identityMembers.memberDid, AGENT));
      }
      expect((await POST(agentSession(ORG))).status).toBe(403);
      expect(h.get).not.toHaveBeenCalled();
      expect(h.personal).not.toHaveBeenCalled();
      expect(h.fallback).not.toHaveBeenCalled();
    },
  );
  it('fails closed on a missing assigned principal connection, naming that DID and its connectors page', async () => {
    await assign(MEMBER);
    h.personal.mockResolvedValue(undefined);
    await expect(resolveBrain({ caller: { actorDid: AGENT, actingFor: MEMBER } }, { connectors: ['anthropic'] }))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining(MEMBER) });
    expect(h.personal.mock.calls).toEqual([[MEMBER]]);
    expect(h.fallback).not.toHaveBeenCalled();
  });
  it('keeps the usable-model route consistent with org agent resolution and revocation', async () => {
    await assign();
    agentSession(ORG);
    const req = () => new NextRequest('https://kernel.test/infer/v1/models/usable');
    const response = await usableModels(req());
    expect(response.status).toBe(200);
    expect((await response.json()).data[0].imajin.credentialDid).toBe(ORG);
    await database.update(identityMembers).set({ removedAt: new Date() }).where(eq(identityMembers.memberDid, AGENT));
    expect((await usableModels(req())).status).toBe(403);
  });
  it('resolves org-held Warp MCP custody for an assigned agent and refuses an unassigned agent or ungranted member', async () => {
    await database.update(connectors).set({ provider: 'org-held-warp' });
    const target = { provider: 'warp', scope: 'warp:dispatch' };
    const agent = { memberDid: AGENT, caller: { actorDid: AGENT, actingAs: ORG } };
    await expect(authorizeExternalMcp(agent, target)).rejects.toMatchObject({ status: 403 });
    await assign();
    const context = await authorizeExternalMcp(agent, target);
    expect(context).toMatchObject({ ownerDid: ORG, credential: h.key });
    expect(await database.select().from(orgConnectionMemberGrants)).toEqual([]);
    await expect(authorizeExternalMcp({ memberDid: MEMBER, caller: { actorDid: MEMBER, actingAs: ORG } }, target))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining('/auth/connectors') });
    await database.update(identityMembers).set({ allowedServices: ['infer'] }).where(eq(identityMembers.memberDid, AGENT));
    await expect(authorizeExternalMcp(agent, target)).rejects.toMatchObject({ status: 403 });
  });
  it('sends the org Warp key through the actual tool route and rechecks assignment on the next call', async () => {
    await assign();
    await database.update(connectors).set({ provider: 'org-held-warp' });
    h.tokenDid = AGENT;
    const req = () => new NextRequest('https://kernel.test/warp/api/runs', {
      headers: { authorization: 'Bearer fixture-app-token', 'x-acting-as': ORG },
    });
    const response = await warpRuns(req());
    expect(response.status).toBe(200);
    await assertPrivate(response);
    expect(await response.json()).toMatchObject({ runs: [] });
    await database.update(identityMembers).set({ removedAt: new Date() }).where(eq(identityMembers.memberDid, AGENT));
    expect((await warpRuns(req())).status).toBe(403);
    expect(upstreamCalls).toBe(1);
  });
});
afterAll(async () => { await client.close(); });
afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('@imajin/auth/session-resolver/v1'));
  setVaultInternalApiKey(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await client.exec('TRUNCATE auth.identities, auth.identity_members, auth.delegation_grants, kernel.connectors, kernel.org_connection_member_grants, kernel.org_connection_suspensions, kernel.vault_delegation_grants');
  vi.clearAllMocks();
  h.key = randomUUID();
  upstreamCalls = 0;
  h.deniedScope = false;
  h.tokenDid = MEMBER;
  h.upstreamMode = 'normal';
  h.session.mockResolvedValue({ error: 'No session', status: 401 });
  h.get.mockResolvedValue({ senderPubkey: 'node-public', custodyScheme: 'delegation-grant' });
  h.unseal.mockImplementation(async () => h.key);
  h.usage.mockResolvedValue(undefined);
  h.personal.mockResolvedValue({ apiKey: randomUUID(), modelId: 'personal-model' });
  provideInternalApiKey(randomUUID());
  vi.stubEnv('AUTH_SERVICE_URL', 'https://auth.test/auth');
  vi.stubEnv('AUTH_INTERNAL_API_KEY', randomUUID());
  await database.insert(identities).values([
    { id: MEMBER, publicKey: 'member-public', scope: 'actor', subtype: 'human' },
    { id: ORG, publicKey: 'org-public', scope: 'business' },
    { id: AGENT, publicKey: 'agent-public', scope: 'actor', subtype: 'agent' },
  ]);
  await database.insert(identityMembers).values({ identityDid: ORG, memberDid: MEMBER, role: 'member' });
  await database.insert(connectors).values({
    id: 'org-connection', ownerDid: ORG, provider: 'org-held-anthropic', slot: 'primary',
    status: 'active', sealedKeyField: FIELD, loadedByDid: MEMBER, loadedAt: new Date(),
  });
  await database.insert(vaultDelegationGrants).values({
    id: 'custody', field: FIELD, subject: ORG, grantedTo: 'did:imajin:node', status: 'active', oneTime: false,
    ownerXPub: 'fixture', wrappedKey: 'fixture', wrappedNonce: 'fixture', keyId: 'fixture', ownerSignature: 'fixture',
  });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/api/apps/token/verify')) {
      return h.deniedScope ? Response.json({ error: 'Scope not granted' }, { status: 403 })
        : Response.json({ appDid: APP, userDid: h.tokenDid, scopes: ['infer:completions', 'warp:dispatch'], attestationId: 'app-grant' });
    }
    if (input.endsWith('/api/internal/verify-delegation')) {
      const { agentDid, principalDid } = JSON.parse(String(init?.body));
      return Response.json(await resolveAgentAuthority(agentDid, principalDid));
    }
    if (input.includes('/controllers/')) {
      const path = new URL(input).pathname.split('/');
      const [membership] = await database.select().from(identityMembers).where(and(
        eq(identityMembers.identityDid, decodeURIComponent(path.at(-3)!)),
        eq(identityMembers.memberDid, decodeURIComponent(path.at(-1)!)),
      ));
      return Response.json({ valid: !!membership && !membership.removedAt, role: membership?.role,
        allowedServices: membership?.allowedServices ?? null });
    }
    if (input.startsWith('https://app.warp.dev/api/v1/')) {
      upstreamCalls++;
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${h.key}`);
      return Response.json({ runs: [] });
    }
    expect(input.startsWith('https://api.anthropic.com/v1/')).toBe(true);
    upstreamCalls++;
    expect(new Headers(init?.headers).get('x-api-key')).toBe(h.key);
    if (input.endsWith('/models')) return Response.json({ data: [{ id: 'claude-org-model', display_name: 'Org model' }] });
    if (h.upstreamMode === 'error') throw new Error(h.key);
    if (h.upstreamMode === 'echo') return Response.json({ id: h.key, content: h.key }, {
      headers: { 'x-api-key': h.key, 'content-type': `application/json; echo=${h.key}` },
    });
    if (h.upstreamMode === 'stream') return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const parts = ['data: {"type":"message_start","message":{"id":"msg_test","usage":{"input_tokens":3}}}\n\n',
          'data: {"text":"', h.key.slice(0, 9), h.key.slice(9), '"}\n\n',
          'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n'];
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
    return Response.json({ id: 'msg_test', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 3, output_tokens: 2 } });
  }));
});

describe('org-held Anthropic inference through real auth, grant SQL and route', () => {
  beforeEach(async () => {
    await database.insert(orgConnectionMemberGrants).values({
      id: 'member-grant', orgDid: ORG, memberDid: MEMBER, connectionId: 'org-connection',
      provider: 'anthropic', grantedAt: new Date(), grantedByDid: MEMBER,
    });
  });
  it('lists org models through real in-process session auth and live grant SQL, without self-HTTP or personal fallback', async () => {
    const resolver = vi.fn(async () => ({ did: MEMBER, scope: 'actor', subtype: 'human' }));
    provideSessionResolver(resolver);
    h.session.mockImplementation(requireSessionAuth);
    const req = new NextRequest('https://kernel.test/infer/v1/models/usable', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=fixture-session`, 'x-acting-as': ORG },
    });
    const response = await usableModels(req);
    expect(response.status).toBe(200);
    const body = await response.clone().json();
    expect(body.data.map((row: { id: string }) => row.id)).toEqual(['claude-org-model']);
    expect(body.data[0].imajin.credentialDid).toBe(ORG);
    expect(resolver).toHaveBeenCalledWith('fixture-session');
    expect(h.personal).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      `https://auth.test/auth/api/groups/${encodeURIComponent(ORG)}/controllers/${encodeURIComponent(MEMBER)}`,
      'https://api.anthropic.com/v1/models',
    ]);
    await assertPrivate(response);
    await database.update(orgConnectionMemberGrants).set({ revokedAt: new Date() });
    const denied = await usableModels(new NextRequest(req));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: expect.stringContaining('/auth/connectors') });
    expect(upstreamCalls).toBe(1);
  });
  it('serves an acting-org call through the in-process session resolver without session self-HTTP', async () => {
    const resolver = vi.fn(async () => ({ did: MEMBER, scope: 'actor', subtype: 'human' }));
    provideSessionResolver(resolver);
    h.session.mockImplementation(requireSessionAuth);
    const req = new NextRequest('https://kernel.test/infer/v1/messages', {
      method: 'POST', headers: { cookie: `${SESSION_COOKIE_NAME}=fixture-session`, 'x-acting-as': ORG },
      body: JSON.stringify({ model: 'claude-test', messages: [], max_tokens: 8 }),
    });
    const response = await POST(req);
    expect(response.status).toBe(200);
    expect(resolver).toHaveBeenCalledWith('fixture-session');
    expect(h.usage).toHaveBeenCalledWith(expect.objectContaining({
      principalDid: MEMBER, metadata: expect.objectContaining({ orgDid: ORG }),
    }));
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      `https://auth.test/auth/api/groups/${encodeURIComponent(ORG)}/controllers/${encodeURIComponent(MEMBER)}`,
      'https://api.anthropic.com/v1/messages',
    ]);
    await assertPrivate(response);
    await database.update(orgConnectionMemberGrants).set({ revokedAt: new Date() });
    expect((await POST(new NextRequest(req.url, {
      method: 'POST', headers: req.headers, body: JSON.stringify({ model: 'claude-test', messages: [] }),
    }))).status).toBe(403);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(upstreamCalls).toBe(1);
  });
  it('rejects an acting-org session when live acting authority disappears, even with an in-process session', async () => {
    provideSessionResolver(async () => ({ did: MEMBER, scope: 'actor', subtype: 'human' }));
    h.session.mockImplementation(requireSessionAuth);
    vi.mocked(fetch).mockResolvedValue(Response.json({ valid: false }));
    const response = await POST(new NextRequest('https://kernel.test/infer/v1/messages', {
      method: 'POST', headers: { cookie: `${SESSION_COOKIE_NAME}=fixture-session`, 'x-acting-as': ORG },
      body: JSON.stringify({ model: 'claude-test', messages: [] }),
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Not authorized to act as this group' });
    expect(h.get).not.toHaveBeenCalled();
    expect(h.unseal).not.toHaveBeenCalled();
    expect(upstreamCalls).toBe(0);
  });
  it.each(['echo', 'stream', 'error'])('keeps keys out of responses, headers, captured logs and metering after upstream %s', async mode => {
    h.upstreamMode = mode;
    const response = await POST(request({ model: 'claude-test', messages: [], stream: mode === 'stream' }));
    expect(response.status).toBe(mode === 'error' ? 502 : 200);
    await assertPrivate(response);
    if (mode === 'stream') {
      await vi.waitFor(() => expect(h.usage).toHaveBeenCalledWith(expect.objectContaining({
        principalDid: MEMBER, tokensIn: 3, tokensOut: 2,
      })));
    }
  });
  it('requires the human grant when that human acts in org context through their own agent', async () => {
    await database.insert(identityMembers).values({ identityDid: MEMBER, memberDid: AGENT, role: 'agent' });
    h.tokenDid = AGENT;
    const req = () => {
      const value = request();
      value.headers.set('x-acting-for', MEMBER);
      return value;
    };
    expect((await POST(req())).status).toBe(200);
    expect(h.usage).toHaveBeenCalledWith(expect.objectContaining({ principalDid: MEMBER, agentDid: AGENT }));
    await database.update(orgConnectionMemberGrants).set({ revokedAt: new Date() });
    const response = await POST(req());
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('/auth/connectors');
    expect(upstreamCalls).toBe(1);
  });
  it('injects only server-side and attributes usage to the member with allowlisted org provenance', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(h.unseal).toHaveBeenCalledTimes(1);
    expect(h.usage).toHaveBeenCalledWith(expect.objectContaining({
      principalDid: MEMBER, agentDid: MEMBER,
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
      await denyNext(!['removed-member', 'suspended-member', 'suspended-org'].includes(boundary));
    },
  );
  it('denies absent human grants but allows an assigned agent without a member grant', async () => {
    await database.update(orgConnectionMemberGrants).set({ revokedAt: new Date() });
    await denyNext();
    await database.update(orgConnectionMemberGrants).set({ revokedAt: null });
    await database.update(identities).set({ subtype: 'agent' }).where(eq(identities.id, MEMBER));
    await database.update(identityMembers).set({ role: 'agent' }).where(eq(identityMembers.memberDid, MEMBER));
    expect((await POST(request())).status).toBe(200);
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
