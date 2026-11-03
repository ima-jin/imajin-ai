import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  db: null as unknown, sessionDid: '', effectiveDid: 'did:imajin:untrusted-selector',
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'), ...await import('@/src/db/schemas/oauth'),
  ...await import('@/src/db/schemas/registry'), ...await import('@/src/db/schemas/connectors'),
  get db() { return h.db; },
}));
vi.mock('@/app/auth/lib/get-effective-did', () => ({
  getEffectiveDid: async () => ({ sessionDid: h.sessionDid || null, effectiveDid: h.effectiveDid }),
}));
vi.mock('@imajin/config', () => ({ rateLimit: () => ({ limited: false }), getClientIP: () => '127.0.0.1' }));
vi.mock('@/src/lib/kernel/app-membership', () => ({ addConsentedApp: vi.fn() }));
vi.mock('@/src/lib/auth/promote-actor', () => ({ promoteActorOnGrant: vi.fn() }));
vi.mock('@/src/lib/kernel/consent-scope-projection', () => ({ projectConsentedScopes: vi.fn() }));
vi.mock('@/src/lib/access/delegate-grant', () => ({ resolveDelegateGrantBearer: vi.fn(async () => ({ ok: false, reason: 'unknown' })) }));
vi.mock('../tools', async () => {
  const { pingTool } = await import('../tools/ping');
  return { ALL_TOOLS: [pingTool], toolByName: (name: string) => name === 'ping' ? pingTool : undefined };
});

import { identities, identityMembers, delegationGrants, attestations, channelLinks } from '@/src/db/schemas/auth';
import { oauthAuthorizationCodes, oauthRefreshTokens } from '@/src/db/schemas/oauth';
import { registryApps } from '@/src/db/schemas/registry';
import { connectors, orgConnectionMemberGrants, orgConnectionSuspensions } from '@/src/db/schemas/connectors';
import { GET as authorizeGet, POST as consent } from '../../../../app/oauth/authorize/route';
import { POST as tokenPost } from '../../../../app/oauth/token/route';
import { GET as choicesGet } from '../../../../app/oauth/agent-bindings/route';
import { POST as mcpPost } from '../../../../app/mcp/route';
import { verifyAppToken, createAppToken } from '@/src/lib/auth/jwt';
import { pkceChallengeFromVerifier } from '../oauth-config';
import { approveAgentBinding, mcpCredentialContext, mcpOAuthContext, readAgentBinding } from '../agent-binding';
import { authorizeMemberConnection } from '@/src/lib/kernel/member-connection-gate';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';

const JIN = 'did:imajin:jin';
const BOT = 'did:imajin:artifact-jin';
const RYAN = 'did:imajin:ryan';
const ORG = 'did:imajin:artifact';
const MEMBER = 'did:imajin:member';
const CLIENT = 'did:imajin:gateway-client';
const CALLBACK = 'http://127.0.0.1:7329/oauth/callback';
const BASE = 'http://127.0.0.1:7328';
const SCOPE = 'media:read discovery:read warp:dispatch';
const tables = [identities, identityMembers, delegationGrants, attestations, channelLinks,
  oauthAuthorizationCodes, oauthRefreshTokens, registryApps, connectors, orgConnectionMemberGrants, orgConnectionSuspensions];
let client: PGlite;
let database: ReturnType<typeof drizzle>;
let signingKey: string;
let signingPublicKey: string;

function ddl(table: PgTable) {
  const config = getTableConfig(table);
  const columns = config.columns.map(column => {
    let value = `"${column.name}" ${column.getSQLType()}`;
    if (column.primary) value += ' PRIMARY KEY';
    if (column.default !== undefined) {
      const literal = column.default instanceof SQL ? new PgDialect().sqlToQuery(column.default).sql
        : `'${(typeof column.default === 'object' ? JSON.stringify(column.default) : String(column.default)).replaceAll("'", "''")}'`;
      value += ` DEFAULT ${literal}`;
    }
    return value;
  });
  return `CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(',')})`;
}

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
beforeAll(async () => {
  const pair = generateKeyPairSync('ed25519');
  signingKey = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex');
  signingPublicKey = pair.publicKey.export({ format: 'jwk' }).x!;
  vi.stubEnv('AUTH_PRIVATE_KEY', signingKey);
  vi.stubEnv('MCP_PUBLIC_URL', BASE);
  vi.stubEnv('APP_URL', BASE);
  client = new PGlite();
  await client.waitReady;
  for (const schema of ['auth', 'registry', 'kernel']) await client.exec(`CREATE SCHEMA ${schema}`);
  for (const table of tables) await client.exec(ddl(table));
  await client.exec('CREATE UNIQUE INDEX channel_pair ON auth.channel_links (channel, channel_uid, app_did)');
  // PGlite serializes transactions; concurrency/real advisory locking is covered by the PostgreSQL consent suite.
  await client.exec('CREATE FUNCTION pg_advisory_xact_lock(bigint) RETURNS void LANGUAGE SQL AS $$ SELECT $$');
  database = drizzle(client);
  h.db = database;
});
afterAll(async () => { await client?.close(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  for (const table of tables) {
    const config = getTableConfig(table);
    await client.exec(`TRUNCATE "${config.schema}"."${config.name}"`);
  }
  h.sessionDid = RYAN;
  await database.insert(identities).values([
    [JIN, 'actor', 'agent'], [BOT, 'actor', 'agent'], [RYAN, 'actor', 'human'],
    [ORG, 'business', null], [MEMBER, 'actor', 'human'],
  ].map(([id, scope, subtype]) => ({ id: id!, scope: scope!, subtype, publicKey: randomBytes(32).toString('hex') })));
  await database.insert(identityMembers).values([
    { identityDid: RYAN, memberDid: JIN, role: 'agent' },
    { identityDid: ORG, memberDid: BOT, role: 'agent' },
    { identityDid: ORG, memberDid: RYAN, role: 'admin' },
    { identityDid: ORG, memberDid: MEMBER, role: 'member' },
  ]);
  await database.insert(registryApps).values({
    id: 'app_gateway', appDid: CLIENT, ownerDid: RYAN, name: 'Gateway OAuth',
    publicKey: randomBytes(32).toString('hex'), callbackUrl: CALLBACK, redirectUris: [CALLBACK],
    requestedScopes: SCOPE.split(' '), status: 'active', visibility: 'public',
  });
  await database.insert(connectors).values([
    { id: 'conn_ryan', ownerDid: RYAN, provider: 'warp', channel: 'warp', connectorDid: 'did:imajin:warp-connector',
      sealedKeyField: `warp-agent-key:${RYAN}` },
    { id: 'conn_artifact', ownerDid: ORG, provider: 'org-held-warp', channel: 'external-mcp',
      connectorDid: 'did:imajin:node', sealedKeyField: `external-mcp:binding:${ORG}`, loadedByDid: RYAN, loadedAt: new Date() },
  ]);
});

function request(path: string, body: object) {
  return new NextRequest(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
async function authorize(agentDid: unknown = JIN, principalDid: unknown = RYAN) {
  const verifier = randomBytes(32).toString('base64url');
  const response = await consent(request('/oauth/authorize', {
    client_id: 'app_gateway', redirect_uri: CALLBACK, scope: SCOPE,
    code_challenge: pkceChallengeFromVerifier(verifier), code_challenge_method: 'S256',
    agent_did: agentDid, acting_for: principalDid,
  }));
  return { response, verifier, body: await response.json() };
}
async function exchange(form: Record<string, string>) {
  return tokenPost(new NextRequest(`${BASE}/oauth/token`, {
    method: 'POST', body: new URLSearchParams({ client_id: 'app_gateway', ...form }),
  }));
}
async function granted(agentDid = JIN, principalDid = RYAN) {
  const { response, body, verifier } = await authorize(agentDid, principalDid);
  expect(response.status).toBe(200);
  const code = new URL(body.redirect).searchParams.get('code')!;
  const result = await exchange({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, code_verifier: verifier });
  expect(result.status).toBe(200);
  return result.json() as Promise<{ access_token: string; refresh_token: string }>;
}
async function context(token: string) {
  const claims = await verifyAppToken(token);
  expect(claims).not.toBeNull();
  return mcpOAuthContext(claims!);
}

describe('explicit agent consent and immutable signed OAuth binding', () => {
  it.each([[JIN, RYAN], [BOT, ORG]])('consents %s as its own subject, never the human or gateway', async (agentDid, principalDid) => {
    const result = await granted(agentDid, principalDid);
    const claims = await verifyAppToken(result.access_token);
    expect(claims).toMatchObject({ sub: agentDid, azp: CLIENT, actingFor: principalDid, aud: `${BASE}/mcp` });
    const [attestation] = await database.select().from(attestations).where(eq(attestations.id, claims!.attestationId));
    expect(attestation).toMatchObject({
      issuerDid: agentDid, subjectDid: CLIENT,
      payload: { agentBinding: { agentDid, principalDid, consentedByDid: RYAN } },
    });
    const publicKey = Buffer.from(signingPublicKey, 'base64url').toString('hex');
    expect(authCrypto.verifySync(attestation.signature, canonicalize({
      subject_did: CLIENT, type: 'app.authorized', context_id: 'app_gateway', context_type: 'app',
      payload: attestation.payload, issued_at: attestation.issuedAt.getTime(),
    }), publicKey)).toBe(true);
    const ctx = await context(result.access_token);
    expect(ctx).toMatchObject({ did: agentDid, actingFor: principalDid, appDid: CLIENT });
    const credential = await mcpCredentialContext(ctx, 'warp');
    expect(credential).toMatchObject({ ownerDid: principalDid, caller: { actorDid: agentDid } });
    const connection = await database.transaction(tx => authorizeMemberConnection(tx, {
      memberDid: agentDid, caller: credential.caller,
    }, { provider: 'warp', scope: 'warp:dispatch', service: 'warp' }));
    expect(connection.ownerDid).toBe(principalDid);
    expect(await database.select().from(orgConnectionMemberGrants)).toEqual([]);
    expect(await database.select().from(delegationGrants)).toEqual([]);
  });
  it('issues separate tokens and authorization lineages to two agents on the same client', async () => {
    const jin = await granted();
    const bot = await granted(BOT, ORG);
    expect(jin.access_token === bot.access_token).toBe(false);
    expect(jin.refresh_token === bot.refresh_token).toBe(false);
    const first = await verifyAppToken(jin.access_token);
    const second = await verifyAppToken(bot.access_token);
    expect(first!.attestationId === second!.attestationId).toBe(false);
    expect((await mcpCredentialContext(await context(jin.access_token), 'warp')).ownerDid).toBe(RYAN);
    expect((await mcpCredentialContext(await context(bot.access_token), 'warp')).ownerDid).toBe(ORG);
  });
  it('does not infer a principal for either one or multiple serviceOf entries', async () => {
    await expect(approveAgentBinding(JIN, undefined, RYAN)).rejects.toMatchObject({ code: 'agent_binding_required' });
    expect((await authorize(JIN, null)).body.error).toBe('agent_binding_required');
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: JIN, role: 'agent' });
    expect((await authorize(JIN, '')).body.error).toBe('agent_binding_required');
    expect(await approveAgentBinding(JIN, ORG, RYAN)).toMatchObject({ agentDid: JIN, principalDid: ORG });
  });
  it.each([null, '', 42, [], {}, 'did:imajin:unknown'])('refuses invalid agent selection %j', async did => {
    const result = await authorize(did, RYAN);
    expect(result.response.status).toBeGreaterThanOrEqual(400);
    expect(await database.select().from(oauthAuthorizationCodes)).toEqual([]);
  });
  it('refuses a connector scope lacking a fixed-assignment adapter, rather than spending agent or gateway keys', async () => {
    await database.update(registryApps).set({ requestedScopes: ['github:read'] });
    const response = await consent(request('/oauth/authorize', {
      client_id: 'app_gateway', redirect_uri: CALLBACK, scope: 'github:read',
      code_challenge: randomBytes(32).toString('base64url'), code_challenge_method: 'S256',
      agent_did: JIN, acting_for: RYAN,
    }));
    expect((await response.json()).error).toBe('agent_scope_unsupported');
    expect(await database.select().from(oauthAuthorizationCodes)).toEqual([]);
  });
  it('refuses a personal agent selecting an unassigned org', async () => {
    expect((await authorize(JIN, ORG)).body.error).toBe('agent_binding_invalid');
  });
  it('refuses empty agent consent scopes rather than restoring the registered default', async () => {
    const response = await consent(request('/oauth/authorize', {
      client_id: 'app_gateway', redirect_uri: CALLBACK, scope: '',
      code_challenge: randomBytes(32).toString('base64url'), code_challenge_method: 'S256',
      agent_did: JIN, acting_for: RYAN,
    }));
    expect((await response.json()).error).toBe('invalid_scope');
    expect(await database.select().from(oauthAuthorizationCodes)).toEqual([]);
  });
  it.each([MEMBER, BOT])('refuses consent by non-admin/non-human %s', async signer => {
    h.sessionDid = signer;
    expect((await authorize(BOT, ORG)).body.error).toBe('agent_consent_forbidden');
  });
  it.each(['removed', 'restricted', 'suspended-org', 'suspended-human'])('refuses org-admin consent that is %s', async boundary => {
    if (boundary === 'removed') await database.update(identityMembers).set({ removedAt: new Date() }).where(eq(identityMembers.memberDid, RYAN));
    if (boundary === 'restricted') await database.update(identityMembers).set({ allowedServices: [] }).where(eq(identityMembers.memberDid, RYAN));
    if (boundary === 'suspended-org') await database.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, ORG));
    if (boundary === 'suspended-human') await database.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, RYAN));
    expect((await authorize(BOT, ORG)).response.status).toBe(403);
  });
  it('requires the assigned human, not an unrelated human or an acting-as cookie', async () => {
    h.sessionDid = MEMBER;
    h.effectiveDid = RYAN;
    expect((await authorize()).body.error).toBe('agent_consent_forbidden');
  });
  it('fails closed for removed assignment, inactive identities, and absent login', async () => {
    await database.update(identityMembers).set({ removedAt: new Date() }).where(eq(identityMembers.memberDid, JIN));
    expect((await authorize()).body.error).toBe('agent_assignment_required');
    await database.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, BOT));
    expect((await authorize(BOT, ORG)).body.error).toBe('agent_assignment_required');
    h.sessionDid = '';
    expect((await authorize()).body.error).toBe('login_required');
  });
  it('carries the same binding across repeated refresh without widening consented scopes', async () => {
    let result = await granted(BOT, ORG);
    await database.update(registryApps).set({ requestedScopes: [...SCOPE.split(' '), 'media:write'] });
    for (let cycle = 0; cycle < 2; cycle++) {
      const response = await exchange({ grant_type: 'refresh_token', refresh_token: result.refresh_token });
      expect(response.status).toBe(200);
      result = await response.json();
      expect(await verifyAppToken(result.access_token)).toMatchObject({ sub: BOT, azp: CLIENT, actingFor: ORG, scope: SCOPE });
    }
  });
  it.each(['agent_did', 'acting_for', 'actAs', 'actingAs'])('rejects token/refresh substitution through %s', async selector => {
    const result = await granted();
    const response = await exchange({ grant_type: 'refresh_token', refresh_token: result.refresh_token, [selector]: ORG });
    expect((await response.json()).error).toBe('agent_binding_immutable');
  });
  it('reconsent changes the binding by a new signed authorization, not by mutating the old token', async () => {
    const old = await granted();
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: JIN, role: 'agent' });
    const next = await granted(JIN, ORG);
    expect((await verifyAppToken(next.access_token))!.actingFor).toBe(ORG);
    await expect(context(old.access_token)).rejects.toMatchObject({ code: 'agent_authorization_required' });
    const refresh = await exchange({ grant_type: 'refresh_token', refresh_token: old.refresh_token });
    expect(refresh.status).toBeGreaterThanOrEqual(400);
    expect((await verifyAppToken(old.access_token))!.actingFor).toBe(RYAN);
  });
});

describe('live credential boundaries and restoration controls', () => {
  it('refuses an expired or missing OAuth authorization at the next access', async () => {
    const ctx = await context((await granted()).access_token);
    await database.update(attestations).set({ expiresAt: new Date(0) }).where(eq(attestations.id, ctx.authorizationId!));
    await expect(mcpCredentialContext(ctx, 'warp')).rejects.toMatchObject({ code: 'agent_authorization_required' });
    await expect(mcpCredentialContext({ ...ctx, authorizationId: 'att_missing' }, 'warp'))
      .rejects.toMatchObject({ code: 'agent_authorization_required' });
  });
  it.each([[JIN, RYAN], [BOT, ORG]])('authenticates %s at the real MCP route as itself', async (agent, principal) => {
    const result = await granted(agent, principal);
    const response = await mcpPost(new NextRequest(`${BASE}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${result.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} } }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).result.content[0].text).toContain(`authenticated as ${agent} at `);
  });
  it.each(['x-acting-as', 'x-acting-for'])('refuses request-level substitution through %s', async header => {
    const result = await granted();
    const response = await mcpPost(new NextRequest(`${BASE}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${result.access_token}`, [header]: ORG },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('agent_binding_immutable');
  });
  it.each(['assignment', 'authorization', 'scope', 'service', 'client'])('refuses the next credential access after %s revocation', async boundary => {
    const result = await granted();
    const ctx = await context(result.access_token);
    await mcpCredentialContext(ctx, 'warp');
    if (boundary === 'assignment') await database.update(identityMembers).set({ removedAt: new Date() })
      .where(eq(identityMembers.memberDid, JIN));
    if (boundary === 'authorization') await database.update(attestations).set({ revokedAt: new Date() })
      .where(eq(attestations.id, ctx.authorizationId!));
    if (boundary === 'scope') await database.update(attestations).set({ payload: {
      scopes: ['media:read'], agentBinding: { agentDid: JIN, principalDid: RYAN, consentedByDid: RYAN },
    } }).where(eq(attestations.id, ctx.authorizationId!));
    if (boundary === 'service') await database.update(identityMembers).set({ allowedServices: ['infer'] })
      .where(eq(identityMembers.memberDid, JIN));
    if (boundary === 'client') await database.update(registryApps).set({ status: 'revoked', revokedAt: new Date() });
    await expect(mcpCredentialContext(ctx, 'warp')).rejects.toThrow(['authorization', 'scope', 'client'].includes(boundary)
      ? '/jin' : '/auth/agents');
  });
  it.each(['revoked', 'expired', 'unloaded', 'suspended'])('refuses an org connection that is %s, without falling back to personal keys', async boundary => {
    const ctx = await context((await granted(BOT, ORG)).access_token);
    const selected = await mcpCredentialContext(ctx, 'warp');
    if (boundary === 'revoked') await database.update(connectors).set({ revokedAt: new Date() }).where(eq(connectors.ownerDid, ORG));
    if (boundary === 'expired') await database.update(connectors).set({ expiresAt: new Date(0) }).where(eq(connectors.ownerDid, ORG));
    if (boundary === 'unloaded') await database.update(connectors).set({ loadedAt: null }).where(eq(connectors.ownerDid, ORG));
    if (boundary === 'suspended') await database.insert(orgConnectionSuspensions).values({ orgDid: ORG, provider: 'warp', suspendedAt: new Date() });
    await expect(database.transaction(tx => authorizeMemberConnection(tx, { memberDid: BOT, caller: selected.caller },
      { provider: 'warp', scope: 'warp:dispatch', service: 'warp' }))).rejects.toMatchObject({ status: 403 });
  });
  it('rejects a token with a mismatched binding or client and an unbound agent token', async () => {
    const claims = (await verifyAppToken((await granted()).access_token))!;
    await expect(mcpOAuthContext({ ...claims, actingFor: ORG })).rejects.toMatchObject({ code: 'agent_authorization_required' });
    await expect(mcpOAuthContext({ ...claims, azp: 'did:imajin:other-client' })).rejects.toMatchObject({ code: 'agent_authorization_required' });
    const token = await createAppToken({ ...claims, actingFor: undefined });
    await expect(context(token)).rejects.toMatchObject({ code: 'agent_authorization_required' });
  });
  it.each([null, 'bad', {}, { agentDid: JIN }, { agentDid: JIN, principalDid: ORG, consentedByDid: 3 }])(
    'never downgrades a malformed signed binding %j to legacy OAuth', binding => {
      expect(() => readAgentBinding({ agentBinding: binding })).toThrow('/jin');
    },
  );
  it('preserves unbound personal-human OAuth and ignores their untrusted acting cookie', async () => {
    const ctx = await mcpOAuthContext({ sub: RYAN, azp: CLIENT, scope: SCOPE, attestationId: 'legacy', aud: `${BASE}/mcp` });
    expect(await mcpCredentialContext(ctx, 'warp')).toEqual({ ownerDid: RYAN });
  });
  it('authenticates and validates assignment choices without caching or public enumeration', async () => {
    const response = await choicesGet(new NextRequest(`${BASE}/oauth/agent-bindings?agent_did=${BOT}`));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.json()).principals.map((p: { did: string }) => p.did)).toEqual([ORG]);
    h.sessionDid = '';
    expect((await choicesGet(new NextRequest(`${BASE}/oauth/agent-bindings?agent_did=${BOT}`))).status).toBe(401);
    h.sessionDid = RYAN;
    expect((await choicesGet(new NextRequest(`${BASE}/oauth/agent-bindings?agent_did=bad`))).status).toBe(400);
  });
  it('preserves only the agent hint through the validated authorization redirect, never an acting selector', async () => {
    const query = new URLSearchParams({
      client_id: 'app_gateway', redirect_uri: CALLBACK, response_type: 'code', scope: SCOPE,
      code_challenge: randomBytes(32).toString('base64url'), code_challenge_method: 'S256',
      agent_did: BOT, acting_for: RYAN,
    });
    const response = await authorizeGet(new NextRequest(`${BASE}/oauth/authorize?${query}`));
    const redirect = new URL(response.headers.get('location')!);
    expect(redirect.searchParams.get('agent_did')).toBe(BOT);
    expect(redirect.searchParams.has('acting_for')).toBe(false);
  });
});
