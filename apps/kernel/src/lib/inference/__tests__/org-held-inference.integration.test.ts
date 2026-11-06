import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  db: null as unknown, key: '', get: vi.fn(), unseal: vi.fn(), usage: vi.fn(),
  log: vi.fn(), personal: vi.fn(), fallback: vi.fn(), session: vi.fn(), deniedScope: false, upstreamMode: 'normal',
  tokenDid: '', complete: vi.fn(),
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
  listConnectorRegistrations: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/src/lib/kernel/app-registrant', () => ({ lookupAppRegistrantDid: h.fallback }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@/src/lib/anthropic/connector', () => ({
  loadAnthropicCredentials: h.personal, ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
}));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: vi.fn() }));
vi.mock('@/src/lib/inference/completions/anthropic-adapter', () => ({ forwardAnthropic: h.complete }));
vi.mock('@/src/lib/inference/completions/openai-compatible-adapter', () => ({ forwardOpenAiCompatible: h.complete }));
vi.mock('@imajin/config', async original => ({
  ...await original<typeof import('@imajin/config')>(), rateLimit: () => ({ limited: false }), getClientIP: () => '127.0.0.1',
}));

import { channelLinks, delegationGrants, identities, identityMembers } from '@/src/db/schemas/auth';
import { connectors, orgConnectionMemberGrants, orgConnectionSuspensions } from '@/src/db/schemas/connectors';
import { vaultDelegationGrants } from '@/src/db/schemas/vault';
import { nodeCustodyGrantFixture } from '@/src/lib/vault/__tests__/node-custody-fixture';
import { provideInternalApiKey, provideSessionResolver } from '@imajin/auth';
import { SESSION_COOKIE_NAME } from '@imajin/config';
import { requireAuth as requireSessionAuth } from '../../../../../../packages/auth/src/require-auth';
import { setVaultInternalApiKey } from '../../../../../../packages/auth/tests/support/internal-post-test-env';
import { EXTERNAL_MCP_NAMESPACE } from '@/src/lib/vault/field-grammar';
import { POST } from '@/app/infer/v1/messages/route';
import { POST as countTokens } from '@/app/infer/v1/messages/count_tokens/route';
import { GET as models } from '@/app/infer/v1/models/route';
import { GET as usableModels } from '@/app/infer/v1/models/usable/route';
import { GET as discoverSelf } from '@/app/infer/v1/self/route';
import { POST as completions } from '@/app/infer/v1/chat/completions/route';
import type { InferenceRoute } from '../route-discovery';
import type { ConnectionCaller } from '@/src/lib/kernel/connection-principal-policy';
import { resolveOrgHeldBrain } from '../org-held-brain';
import { resolveBrain } from '../brain';
import { authorizeExternalMcp } from '@/src/lib/kernel/external-mcp';
import { GET as warpRuns } from '@/app/warp/api/runs/route';
import { resolveAgentAuthority } from '@/src/lib/auth/agent-authority';
import { createAppToken } from '@/src/lib/auth/jwt';
import { POST as verifyToken } from '@/app/auth/api/apps/token/verify/route';
import { createProxyServer } from '../../../../../../packages/openclaw-infer-passthrough/src/server';
import { loadConfig } from '../../../../../../packages/openclaw-infer-passthrough/src/config';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const MEMBER = 'did:imajin:member';
const ORG = 'did:imajin:artifact';
const APP = 'did:imajin:app';
const AGENT = 'did:imajin:agent';
const FIELD = `anthropic-api-key:${ORG}`;
const credentialHash = (value: string) => createHash('sha256').update(value).digest('hex');
const tables = [identities, identityMembers, delegationGrants, channelLinks, connectors, orgConnectionMemberGrants, orgConnectionSuspensions, vaultDelegationGrants];
let client: PGlite;
let database: ReturnType<typeof drizzle>;
let upstreamCalls = 0;
const httpFetch = globalThis.fetch;

async function useWarpConnection() {
  const field = `${EXTERNAL_MCP_NAMESPACE}:org-fixture:${ORG}`;
  await database.update(connectors).set({
    provider: 'org-held-warp', sealedKeyField: field, loadedByDid: MEMBER, loadedAt: new Date(),
  });
  await database.update(vaultDelegationGrants).set({ field });
}

describe('Artifact org bot through agent-mode passthrough and kernel (#3184)', () => {
  let server: ReturnType<typeof createProxyServer>;
  let baseUrl: string;
  let token: string;
  const kernelCalls: Headers[] = [];

  beforeEach(async () => {
    // Use the real kernel token signer/verifier with ephemeral, in-memory material.
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    await database.update(identities).set({ handle: 'artifact' }).where(eq(identities.id, ORG));
    await database.insert(identityMembers).values({
      identityDid: ORG, memberDid: AGENT, role: 'agent', allowedServices: ['infer'],
    });
    token = await createAppToken({
      azp: AGENT, sub: AGENT, scope: 'infer:completions', attestationId: randomUUID(),
    });
    kernelCalls.length = 0;
    const fakeServices = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (input.startsWith(baseUrl)) return httpFetch(input, init);
      if (input === 'https://kernel.test/infer/v1/messages') {
        kernelCalls.push(new Headers(init?.headers));
        return POST(new NextRequest(input, init));
      }
      if (input.endsWith('/api/apps/token/verify')) {
        return verifyToken(new NextRequest(input, init));
      }
      return fakeServices(input, init);
    }));
    server = createProxyServer(loadConfig({ KERNEL_BASE_URL: 'https://kernel.test' }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  function call(credential = token, selector: string | null = ORG) {
    return fetch(`${baseUrl}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': credential, 'anthropic-version': '2023-06-01',
        ...(selector ? { 'x-acting-as': selector } : {}),
        'x-imajin-session': 'artifact-proof', 'x-imajin-turn': 'artifact-turn',
      },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 8, messages: [{ role: 'user', content: 'proof' }] }),
    });
  }
  function assertNoDispatch() {
    expect(h.get).not.toHaveBeenCalled();
    expect(h.unseal).not.toHaveBeenCalled();
    expect(h.personal).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
    expect(h.usage).not.toHaveBeenCalled();
    expect(upstreamCalls).toBe(0);
  }

  it('bills @artifact with the org bot as actor, using org custody without a member grant', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await database.select().from(orgConnectionMemberGrants)).toEqual([]);
    expect((await database.select().from(identities).where(eq(identities.id, ORG)))[0].handle).toBe('artifact');
    expect(kernelCalls).toHaveLength(1);
    expect(kernelCalls[0].get('x-api-key')).toBe(token);
    expect(kernelCalls[0].get('x-acting-as')).toBe(ORG);
    expect(kernelCalls[0].has('x-acting-for')).toBe(false);
    expect(h.get).toHaveBeenCalledWith(FIELD);
    expect(h.usage).toHaveBeenCalledTimes(1);
    expect(h.usage).toHaveBeenCalledWith(expect.objectContaining({
      principalDid: ORG, agentDid: AGENT, tokensIn: 3, tokensOut: 2,
      sessionId: 'artifact-proof', turnId: 'artifact-turn',
      metadata: { orgDid: ORG, connectionId: 'org-connection', format: 'anthropic-messages' },
    }));
    expect(h.personal).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
    expect(upstreamCalls).toBe(1);
    await assertPrivate(response);
  });

  it('keeps a personal-agent credential on its human keys without an org selector', async () => {
    await database.update(identityMembers).set({ identityDid: MEMBER }).where(eq(identityMembers.memberDid, AGENT));
    const personalToken = await createAppToken({
      azp: AGENT, sub: MEMBER, scope: 'infer:completions', attestationId: randomUUID(),
    });
    h.personal.mockResolvedValue({ apiKey: h.key, modelId: 'personal-model' });
    const response = await call(personalToken, null);
    expect(response.status).toBe(200);
    expect(h.personal.mock.calls).toEqual([[MEMBER]]);
    expect(h.get).not.toHaveBeenCalled();
    expect(h.usage).toHaveBeenCalledWith(expect.objectContaining({ principalDid: MEMBER }));
    expect(kernelCalls[0].has('x-acting-as')).toBe(false);
    expect(h.fallback).not.toHaveBeenCalled();
  });

  it('refuses a personal agent selecting an org it is not assigned to, even with org membership', async () => {
    await database.update(identityMembers).set({ identityDid: MEMBER }).where(eq(identityMembers.memberDid, AGENT));
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: AGENT, role: 'member' });
    expect((await call()).status).toBe(403);
    assertNoDispatch();
  });

  it.each(['status-off', 'removed', 'assignment-revoked'] as const)(
    'refuses the next call after %s with no cached credential or fallback', async state => {
      expect((await call()).status).toBe(200);
      if (state === 'status-off') await database.update(connectors).set({ status: 'revoked' });
      if (state === 'removed') await database.update(connectors).set({ revokedAt: new Date() });
      if (state === 'assignment-revoked') {
        await database.update(identityMembers).set({ removedAt: new Date() }).where(eq(identityMembers.memberDid, AGENT));
      }
      vi.clearAllMocks();
      upstreamCalls = 0;
      const response = await call();
      expect(response.status).toBe(403);
      if (state !== 'assignment-revoked') {
        expect(await response.clone().json()).toMatchObject({
          code: 'connection_not_loaded', error: expect.stringContaining('/auth/connectors'),
        });
      }
      assertNoDispatch();
      await assertPrivate(response);
    },
  );

  it('refuses a tampered signature at the real verifier without session fallback', async () => {
    const [header, claims] = token.split('.');
    const invalid = `${header}.${claims}.${Buffer.alloc(64).toString('base64url')}`;
    expect((await call(invalid)).status).toBe(401);
    expect(h.session).not.toHaveBeenCalled();
    assertNoDispatch();
  });

  it('does not treat an org-subject token as the org bot signing as itself', async () => {
    const orgSubject = await createAppToken({
      azp: AGENT, sub: ORG, scope: 'infer:completions', attestationId: randomUUID(),
    });
    expect((await call(orgSubject)).status).toBe(403);
    assertNoDispatch();
  });
});

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

describe('self-discovery with real app auth, assignment and grant SQL (#3250)', () => {
  function selfRequest(actingAs?: string, actingFor?: string) {
    h.tokenDid = AGENT;
    return new NextRequest('https://kernel.test/infer/v1/self', { headers: {
      authorization: 'Bearer fixture-app-token',
      ...(actingAs ? { 'x-acting-as': actingAs } : {}),
      ...(actingFor ? { 'x-acting-for': actingFor } : {}),
    } });
  }
  async function bodyAndParity(req: NextRequest) {
    const response = await discoverSelf(req);
    expect(response.status).toBe(200);
    const body = await response.clone().json();
    const catalog = await usableModels(new NextRequest('https://kernel.test/infer/v1/models/usable', { headers: req.headers }));
    expect(catalog.status).toBe(200);
    expect(body.usableModels.map((row: { id: string }) => row.id))
      .toEqual((await catalog.json()).data.map((row: { id: string }) => row.id));
    await assertPrivate(response);
    expect(await response.text()).not.toContain(FIELD);
    return body;
  }
  it('lists the org-owned plain anthropic row as org-held, never as a personal connector, with catalog parity', async () => {
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: AGENT, role: 'agent', allowedServices: ['infer'] });
    await database.update(identities).set({ handle: 'artifact' }).where(eq(identities.id, ORG));
    const body = await bodyAndParity(selfRequest(ORG));
    expect(body.identity).toMatchObject({ did: AGENT, kind: 'agent', actAs: ORG });
    expect(body.connectors.find((row: { kind?: string }) => row.kind === 'A')).toMatchObject({
      authority: 'org-held', family: 'anthropic', billedPrincipal: { did: ORG, handle: 'artifact' },
      usable: true, usableModels: ['claude-org-model'],
    });
    expect(body.connectors.some((row: { provider: string; authority: string; billedPrincipal?: { did: string } }) =>
      row.provider === 'anthropic' && row.billedPrincipal?.did === ORG && row.authority === 'own-key')).toBe(false);
    expect(await database.select().from(orgConnectionMemberGrants)).toEqual([]);
  });
  it('keeps a personal agent on its own identity and its human principal model list', async () => {
    await database.insert(identityMembers).values({ identityDid: MEMBER, memberDid: AGENT, role: 'agent' });
    const body = await bodyAndParity(selfRequest(undefined, MEMBER));
    expect(body.identity).toMatchObject({ did: AGENT, kind: 'agent', actAs: null });
    expect(body.connectors.find((row: { kind?: string; provider: string }) => row.kind === 'B' && row.provider === 'anthropic'))
      .toMatchObject({ authority: 'delegated', billedPrincipal: { did: MEMBER }, usable: true });
    // The token includes warp:dispatch, but no actual tool manifest grants it.
    expect(body.connectors.find((row: { provider: string }) => row.provider === 'warp')).toMatchObject({
      ownerDid: MEMBER, usable: false, grantStatus: 'denied', configurationStatus: 'not-disclosed',
      fix: { href: '/auth/connectors/warp', actingDid: MEMBER },
    });
  });
  it('rechecks the member grant after revocation and names the exact existing control', async () => {
    await database.insert(identityMembers).values({ identityDid: MEMBER, memberDid: AGENT, role: 'agent' });
    await database.insert(orgConnectionMemberGrants).values({
      id: 'self-grant', orgDid: ORG, memberDid: MEMBER, connectionId: 'org-connection',
      provider: 'anthropic', grantedByDid: MEMBER, grantedAt: new Date(),
    });
    const before = await bodyAndParity(selfRequest(ORG, MEMBER));
    expect(before.connectors.find((row: { kind?: string }) => row.kind === 'C')).toMatchObject({ usable: true });
    await database.update(orgConnectionMemberGrants).set({ revokedAt: new Date() });
    const response = await discoverSelf(selfRequest(ORG, MEMBER));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      usableModels: [], connectors: expect.arrayContaining([expect.objectContaining({
        kind: 'C', authority: 'member-grant', usable: false, grantStatus: 'denied',
        reason: expect.objectContaining({ code: 'no_grant' }),
        fix: expect.objectContaining({
          control: 'Org service keys → Member grants → Grant',
          href: '/auth/connectors#org-connector-anthropic-grants', actingDid: ORG,
        }),
      })]),
    });
  });
  it.each(['unassigned', 'removed', 'service-excluded', 'wrong-scope'] as const)(
    'preserves usable-model 403 shape for %s selection without a partial response', async boundary => {
      if (boundary !== 'unassigned') await database.insert(identityMembers).values({
        identityDid: ORG, memberDid: AGENT, role: 'agent',
        allowedServices: boundary === 'service-excluded' ? ['warp'] : ['infer'],
        ...(boundary === 'removed' ? { removedAt: new Date() } : {}),
      });
      h.deniedScope = boundary === 'wrong-scope';
      const req = selfRequest(ORG);
      const response = await discoverSelf(req);
      const catalog = await usableModels(new NextRequest('https://kernel.test/infer/v1/models/usable', { headers: req.headers }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(await catalog.json());
      expect(h.get).not.toHaveBeenCalled();
      expect(h.unseal).not.toHaveBeenCalled();
    },
  );

});

describe.each(['agent', 'presence'])('route discovery ≡ chat/completions for %s (real auth, assignment and grant SQL)', subtype => {
  beforeEach(async () => {
    await database.update(identities).set({ subtype }).where(eq(identities.id, AGENT));
  });
  const ORG_MODEL = 'claude-sonnet-5-5';
  async function assignTo(did: string, allowedServices: string[] | null = null) {
    await database.insert(identityMembers).values({ identityDid: did, memberDid: AGENT, role: 'agent', allowedServices });
  }
  async function grantMember() {
    await database.insert(orgConnectionMemberGrants).values({
      id: 'parity-grant', orgDid: ORG, memberDid: MEMBER, connectionId: 'org-connection',
      provider: 'anthropic', grantedByDid: MEMBER, grantedAt: new Date(),
    });
  }
  function parityRequest(caller: ConnectionCaller, model: string | undefined, listing: boolean) {
    h.tokenDid = caller.actorDid;
    const headers = {
      authorization: 'Bearer fixture-app-token',
      ...(caller.actingAs ? { 'x-acting-as': caller.actingAs } : {}),
      ...(caller.actingFor ? { 'x-acting-for': caller.actingFor } : {}),
    };
    const query = new URLSearchParams({ explain: '1', ...(model ? { model } : {}) });
    return new NextRequest(`https://kernel.test/infer/v1/${listing ? `models/usable?${query}` : 'chat/completions'}`, {
      headers, ...(listing ? {} : {
        method: 'POST', body: JSON.stringify({ ...(model ? { model } : {}), messages: [{ role: 'user', content: 'fixture' }] }),
      }),
    });
  }
  async function assertParity(caller: ConnectionCaller, principalDid: string, kind: InferenceRoute['kind'], model?: string) {
    const listing = await usableModels(parityRequest(caller, model, true));
    const body = await listing.clone().json();
    const route = (body.routes as InferenceRoute[] | undefined)?.find(row =>
      row.kind === kind && row.card.provider === 'anthropic' && row.billedPrincipal.did === principalDid
      && row.selectors.actingFor === caller.actingFor && row.selectors.actingAs === caller.actingAs);
    h.complete.mockClear();
    const call = await completions(parityRequest(caller, model, false));
    const diagnostics = { status: listing.status, kinds: body.routes?.map((row: InferenceRoute) => ({
      kind: row.kind, did: row.billedPrincipal.did, usable: row.usable, reason: row.reason?.code,
    })) };
    expect(route?.usable ?? false, JSON.stringify(diagnostics)).toBe(call.ok);
    expect(h.complete).toHaveBeenCalledTimes(call.ok ? 1 : 0);
    if (call.ok) {
      expect(h.complete.mock.calls[0][0]).toMatchObject({ credentialDid: principalDid, modelId: route!.selectedModels[0] });
    }
    expect(await listing.clone().text()).not.toContain(h.key);
    expect(await listing.clone().text()).not.toContain(FIELD);
    return { listing, call, route, body };
  }

  it.each(['agent-self', 'agent-org', 'agent-human', 'member-granted', 'member-ungranted', 'agent-unassigned'] as const)(
    'agrees for %s, with no personal/app/registrant fallback on denied routes', async scenario => {
      let caller: ConnectionCaller = { actorDid: AGENT };
      let principal = AGENT;
      let kind: InferenceRoute['kind'] = 'own';
      let model = 'personal-model';
      if (scenario === 'agent-org' || scenario === 'agent-unassigned') {
        caller = { actorDid: AGENT, actingAs: ORG };
        principal = ORG; kind = 'A'; model = ORG_MODEL;
        if (scenario === 'agent-org') await assignTo(ORG, ['infer']);
      }
      if (scenario === 'agent-human') {
        await assignTo(MEMBER, ['infer']);
        caller = { actorDid: AGENT, actingFor: MEMBER };
        principal = MEMBER; kind = 'B';
      }
      if (scenario === 'member-granted' || scenario === 'member-ungranted') {
        caller = { actorDid: MEMBER, actingAs: ORG };
        principal = ORG; kind = 'C'; model = ORG_MODEL;
        if (scenario === 'member-granted') await grantMember();
      }
      const { call, route, listing } = await assertParity(caller, principal, kind, model);
      const allowed = !['member-ungranted', 'agent-unassigned'].includes(scenario);
      expect(call.ok).toBe(allowed);
      expect(h.fallback).not.toHaveBeenCalled();
      if (scenario === 'member-ungranted') expect(route?.reason?.code).toBe('no_grant');
      if (scenario === 'agent-unassigned') expect(listing.status).toBe(403);
      if (scenario === 'agent-org') {
        expect(route).toMatchObject({ kind: 'A', selectedModels: [ORG_MODEL], usable: true });
        expect(await database.select().from(orgConnectionMemberGrants)).toEqual([]);
      }
    },
  );
  it('keeps the assigned-human/org-member chain on the human grant, and rechecks revocation', async () => {
    await assignTo(MEMBER);
    await grantMember();
    const caller = { actorDid: AGENT, actingFor: MEMBER, actingAs: ORG };
    expect((await assertParity(caller, ORG, 'C', ORG_MODEL)).route?.usable).toBe(true);
    await database.update(orgConnectionMemberGrants).set({ revokedAt: new Date() });
    expect((await assertParity(caller, ORG, 'C', ORG_MODEL)).route?.reason?.code).toBe('no_grant');
  });
  it('proves the Artifact-Jin → @artifact Sonnet 5.5 route using the real resolver and public DID fixtures', async () => {
    const agentDid = 'did:imajin:8gqnAWGGms2cyrZ4krfNQjknYWMfJcoHgnxha8AfKwUY';
    const orgDid = 'did:imajin:Fp5QtWo9vsmS7G5AcbuEUrPT6oGbKxj5gke6T4voH7xE';
    const field = `anthropic-api-key:${orgDid}`;
    await database.insert(identities).values([
      { id: agentDid, publicKey: 'artifact-agent-public', scope: 'actor', subtype: 'agent' },
      { id: orgDid, publicKey: 'artifact-org-public', scope: 'business', handle: 'artifact' },
    ]);
    await database.insert(identityMembers).values({ identityDid: orgDid, memberDid: agentDid, role: 'agent', allowedServices: ['infer'] });
    await database.insert(connectors).values({
      id: 'artifact-anthropic', ownerDid: orgDid, provider: 'anthropic', slot: 'primary',
      status: 'active', sealedKeyField: field, loadedByDid: MEMBER, loadedAt: new Date(),
    });
    await database.insert(vaultDelegationGrants).values(nodeCustodyGrantFixture(field));
    const result = await assertParity({ actorDid: agentDid, actingAs: orgDid }, orgDid, 'A', ORG_MODEL);
    expect(result.route).toMatchObject({
      kind: 'A', billedPrincipal: { did: orgDid, handle: 'artifact' }, selectedModels: [ORG_MODEL], usable: true,
    });
    expect(await database.select().from(orgConnectionMemberGrants)).toEqual([]);
  });
  it('reports an org card without an explicit model as unusable just as the call rejects it', async () => {
    await assignTo(ORG);
    const result = await assertParity({ actorDid: AGENT, actingAs: ORG }, ORG, 'A');
    expect(result.route).toMatchObject({ usable: false, reason: { code: 'no_model_selected' } });
    expect(result.call.status).toBe(400);
  });
  it('does not let an excluded service borrow authority from a parallel delegation', async () => {
    await assignTo(ORG, ['warp']);
    await database.insert(delegationGrants).values({
      id: 'parallel', agentDid: AGENT, delegatorDid: ORG, audience: { type: 'all' },
      issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), status: 'active',
    });
    const listing = await usableModels(parityRequest({ actorDid: AGENT }, undefined, true));
    const { routes } = await listing.json();
    expect(routes.find((route: InferenceRoute) => route.kind === 'A')).toMatchObject({
      usable: false, reason: { code: 'not_authorized' }, selectedModels: [],
    });
    expect(h.get).not.toHaveBeenCalled();
    expect((await completions(parityRequest({ actorDid: AGENT, actingAs: ORG }, ORG_MODEL, false))).status).toBe(403);
  });
  it('does not expose unrelated or revoked/expired/wrong-audience assignments', async () => {
    await database.insert(identities).values({ id: 'did:imajin:unrelated', publicKey: 'other', scope: 'business' });
    await database.insert(delegationGrants).values({
      id: 'wrong-audience', agentDid: AGENT, delegatorDid: 'did:imajin:unrelated',
      audience: { type: 'dids', values: [MEMBER] }, issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000), status: 'active',
    });
    const response = await usableModels(parityRequest({ actorDid: AGENT }, undefined, true));
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('did:imajin:unrelated');
    expect(h.get).not.toHaveBeenCalled();
  });
});

describe.each(['agent', 'presence'])('personal actingAs catalog for %s with real auth and principal SQL', subtype => {
  beforeEach(async () => {
    await database.update(identities).set({ subtype }).where(eq(identities.id, AGENT));
    h.tokenDid = AGENT;
    h.personal.mockImplementation(async did => did === MEMBER ? { apiKey: h.key, modelId: 'personal-model' } : undefined);
  });
  function catalogRequest() {
    return new NextRequest('https://kernel.test/infer/v1/models/usable', {
      headers: { authorization: 'Bearer fixture-app-token', 'x-acting-as': MEMBER },
    });
  }

  it('returns 200 with only the human catalog and resolves imajin models using personal keys', async () => {
    await database.insert(identityMembers).values({
      identityDid: MEMBER, memberDid: AGENT, role: 'agent', allowedServices: ['infer'],
    });
    const response = await usableModels(catalogRequest());
    expect(response.status).toBe(200);
    const { data } = await response.clone().json();
    expect(data).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'personal-model', imajin: expect.objectContaining({ credentialDid: MEMBER, servable: true }),
    })]));
    expect(data.every((model: { imajin: { credentialDid: string } }) => model.imajin.credentialDid === MEMBER)).toBe(true);
    expect(h.personal.mock.calls.every(([did]) => did === MEMBER)).toBe(true);
    const brain = await resolveBrain({ caller: { actorDid: AGENT, actingAs: MEMBER } }, {
      connectors: ['anthropic'], model: 'imajin/personal-model',
    });
    expect(brain).toMatchObject({ credentialDid: MEMBER, actorDid: AGENT, modelId: 'personal-model' });
    expect(h.get).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
    await assertPrivate(response);
  });

  it.each(['unassigned', 'removed', 'service-excluded'])('refuses a personal selector when %s without key access', async boundary => {
    if (boundary !== 'unassigned') await database.insert(identityMembers).values({
      identityDid: MEMBER, memberDid: AGENT, role: 'agent',
      allowedServices: boundary === 'service-excluded' ? ['warp'] : ['infer'],
      ...(boundary === 'removed' ? { removedAt: new Date() } : {}),
    });
    const response = await usableModels(catalogRequest());
    expect(response.status).toBe(403);
    expect(h.personal).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  });
});

describe('presence sessions through completions with real assignment and member-grant SQL', () => {
  beforeEach(async () => {
    await database.update(identities).set({ subtype: 'presence' }).where(eq(identities.id, AGENT));
  });
  function presenceSession(actingAs?: string) {
    h.session.mockResolvedValue({ identity: {
      id: AGENT, scope: 'actor', subtype: 'presence', actingFor: MEMBER, actingAs,
    } });
    return new NextRequest('https://kernel.test/infer/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: actingAs ? 'claude-test' : 'personal-model', messages: [{ role: 'user', content: 'fixture' }] }),
    });
  }
  async function grantOrgMember() {
    await database.insert(orgConnectionMemberGrants).values({
      id: 'presence-member-grant', orgDid: ORG, memberDid: MEMBER, connectionId: 'org-connection',
      provider: 'anthropic', grantedByDid: MEMBER, grantedAt: new Date(),
    });
  }
  it.each([undefined, ORG])('allows an assigned presence acting for a human with actingAs=%s and rechecks removal', async actingAs => {
    await database.insert(identityMembers).values({
      identityDid: MEMBER, memberDid: AGENT, role: 'agent', allowedServices: ['infer'],
    });
    if (actingAs) await grantOrgMember();
    const response = await completions(presenceSession(actingAs));
    expect(response.status).toBe(200);
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({
      credentialDid: actingAs ?? MEMBER, actorDid: AGENT,
    }), expect.anything(), expect.anything());
    expect(h.fallback).not.toHaveBeenCalled();
    if (actingAs) {
      expect(h.personal).not.toHaveBeenCalled();
      expect(h.get).toHaveBeenCalledWith(FIELD);
    } else {
      expect(h.personal.mock.calls).toEqual([[MEMBER]]);
      expect(h.get).not.toHaveBeenCalled();
    }
    await assertPrivate(response);
    await database.update(identityMembers).set({ removedAt: new Date() }).where(eq(identityMembers.memberDid, AGENT));
    vi.clearAllMocks();
    const denied = await completions(presenceSession(actingAs));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'Agent is not assigned to this identity or service' });
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.personal).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  });
  it.each([undefined, ORG])('refuses an unassigned presence with actingAs=%s even with a human member grant', async actingAs => {
    await grantOrgMember();
    const response = await completions(presenceSession(actingAs));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Agent is not assigned to this identity or service' });
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.personal).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  });
  it('requires the human member grant separately from the presence assignment', async () => {
    await database.insert(identityMembers).values({ identityDid: MEMBER, memberDid: AGENT, role: 'agent' });
    const response = await completions(presenceSession(ORG));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('/auth/connectors');
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.personal).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  });
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
    await useWarpConnection();
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
    await useWarpConnection();
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
  it.each(['agent', 'presence'])('sends the org Warp key for %s through the actual tool route and rechecks assignment', async subtype => {
    await database.update(identities).set({ subtype }).where(eq(identities.id, AGENT));
    await assign();
    await useWarpConnection();
    h.tokenDid = AGENT;
    const req = () => new NextRequest('https://kernel.test/warp/api/runs', {
      headers: { authorization: 'Bearer fixture-app-token', 'x-acting-for': ORG },
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
  await client.exec('TRUNCATE auth.identities, auth.identity_members, auth.delegation_grants, auth.channel_links, kernel.connectors, kernel.org_connection_member_grants, kernel.org_connection_suspensions, kernel.vault_delegation_grants');
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
  h.complete.mockImplementation(async brain => Response.json({ model: brain.modelId }));
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
    id: 'org-connection', ownerDid: ORG, provider: 'anthropic', slot: 'primary',
    status: 'active', sealedKeyField: FIELD, loadedByDid: MEMBER, loadedAt: new Date(),
  });
  await database.insert(vaultDelegationGrants).values({ ...nodeCustodyGrantFixture(FIELD), id: 'custody' });
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

describe('prod-shaped sealed Anthropic org resolution (#3313)', () => {
  it.each([
    { assigned: true, missing: 'loader' }, { assigned: true, missing: 'time' }, { assigned: true, missing: 'both' },
    { assigned: false, missing: 'loader' }, { assigned: false, missing: 'time' }, { assigned: false, missing: 'both' },
  ])('refuses missing $missing provenance with assignedAgent=$assigned even for the exact org field', async ({ assigned, missing }) => {
    const selected = await context(assigned);
    await database.update(connectors).set({
      ...(missing !== 'time' ? { loadedByDid: null } : {}),
      ...(missing !== 'loader' ? { loadedAt: null } : {}),
    });
    await expect(resolveOrgHeldBrain(selected, 'claude-test')).rejects.toMatchObject({
      status: 403, code: 'connection_not_loaded', message: expect.stringContaining(ORG),
    });
    expect(h.get).not.toHaveBeenCalled();
    expect(h.unseal).not.toHaveBeenCalled();
    expect(h.personal).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  });

  async function context(assigned: boolean) {
    if (assigned) {
      await database.insert(identityMembers).values({
        identityDid: ORG, memberDid: AGENT, role: 'agent', allowedServices: ['infer'],
      });
      return { memberDid: AGENT, orgDid: ORG, assignedAgentDid: AGENT };
    }
    await database.insert(orgConnectionMemberGrants).values({
      id: 'sealed-member-grant', orgDid: ORG, memberDid: MEMBER, connectionId: 'org-connection',
      provider: 'anthropic', grantedAt: new Date(), grantedByDid: MEMBER,
    });
    return { memberDid: MEMBER, orgDid: ORG };
  }

  it.each([true, false])('resolves the org-owned primary sealed connector with assignedAgent=%s', async assigned => {
    await database.insert(connectors).values({
      id: 'personal-connection', ownerDid: MEMBER, provider: 'anthropic', slot: 'primary',
      status: 'active', sealedKeyField: `anthropic-api-key:${MEMBER}`,
    });
    const brain = await resolveOrgHeldBrain(await context(assigned), 'claude-test');
    expect(brain).toMatchObject({
      provider: 'anthropic', credentialDid: ORG, modelId: 'claude-test',
      orgUsage: { orgDid: ORG, connectionId: 'org-connection', memberDid: assigned ? ORG : MEMBER },
    });
    expect(credentialHash(brain.apiKey)).toBe(credentialHash(h.key));
    expect(h.get).toHaveBeenCalledWith(FIELD);
    expect(h.unseal).toHaveBeenCalledTimes(1);
    expect(h.personal).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  });

  it.each([true, false])('never borrows a personal or other-org row with assignedAgent=%s', async assigned => {
    const selected = await context(assigned);
    await database.update(connectors).set({ ownerDid: MEMBER });
    await database.insert(connectors).values({
      id: 'other-org-connection', ownerDid: 'did:imajin:other-org', provider: 'anthropic',
      slot: 'primary', status: 'active', sealedKeyField: 'anthropic-api-key:did:imajin:other-org',
    });
    await expect(resolveOrgHeldBrain(selected, 'claude-test')).rejects.toMatchObject({
      status: 403, code: 'connection_not_loaded', message: expect.stringContaining(ORG),
    });
    expect(h.get).not.toHaveBeenCalled();
    expect(h.unseal).not.toHaveBeenCalled();
    expect(h.personal).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  });

  it.each(['secondary-slot', 'registry-provider', 'personal-field', 'unrelated-field'] as const)(
    'refuses %s without credential access', async boundary => {
      const selected = await context(true);
      const changes = {
        'secondary-slot': { slot: 'secondary' },
        'registry-provider': { provider: 'org-held-anthropic' },
        'personal-field': { sealedKeyField: `anthropic-api-key:${MEMBER}` },
        'unrelated-field': { sealedKeyField: `anthropic-billing-api-key:${ORG}` },
      };
      await database.update(connectors).set(changes[boundary]);
      await expect(resolveOrgHeldBrain(selected, 'claude-test')).rejects.toMatchObject({
        status: 403, code: 'connection_not_loaded', message: expect.stringContaining(ORG),
      });
      expect(h.get).not.toHaveBeenCalled();
      expect(h.unseal).not.toHaveBeenCalled();
      expect(h.personal).not.toHaveBeenCalled();
      expect(h.fallback).not.toHaveBeenCalled();
    },
  );
});

describe('org-held Anthropic inference through real auth, grant SQL and route', () => {
  beforeEach(async () => {
    await database.insert(orgConnectionMemberGrants).values({
      id: 'member-grant', orgDid: ORG, memberDid: MEMBER, connectionId: 'org-connection',
      provider: 'anthropic', grantedAt: new Date(), grantedByDid: MEMBER,
    });
  });
  it.each(['personal-field', 'unrelated-field'] as const)(
    'refuses a granted org row referencing %s even with loader metadata', async boundary => {
      await database.update(connectors).set({
        sealedKeyField: boundary === 'personal-field' ? `anthropic-api-key:${MEMBER}` : `anthropic-billing-api-key:${ORG}`,
        loadedByDid: MEMBER, loadedAt: new Date(),
      });
      await expect(resolveOrgHeldBrain({ memberDid: MEMBER, orgDid: ORG }, 'claude-test')).rejects.toMatchObject({
        status: 403, code: 'connection_not_loaded', message: expect.stringContaining(ORG),
      });
      expect(h.get).not.toHaveBeenCalled();
      expect(h.unseal).not.toHaveBeenCalled();
      expect(h.personal).not.toHaveBeenCalled();
      expect(h.fallback).not.toHaveBeenCalled();
    },
  );
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
