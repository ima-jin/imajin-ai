import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';

const h = vi.hoisted(() => ({
  db: null as unknown, session: vi.fn(), publish: vi.fn(), log: vi.fn(),
  sql: vi.fn(), effective: vi.fn(),
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'), ...await import('@/src/db/schemas/registry'),
  get db() { return h.db; },
}));
vi.mock('@imajin/db', () => ({ getClient: () => h.sql }));
vi.mock('@imajin/auth', async original => ({
  ...await original<typeof import('@imajin/auth')>(), requireAuth: h.session,
}));
vi.mock('@imajin/bus', () => ({ publish: h.publish }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: h.log, error: h.log, warn: h.log }) }));
vi.mock('@imajin/config', async original => ({
  ...await original<typeof import('@imajin/config')>(), buildPublicUrlAbsolute: () => 'https://kernel.test',
}));
vi.mock('@/app/auth/lib/get-effective-did', () => ({ getEffectiveDid: h.effective }));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { identities, identityMembers, delegationGrants, channelLinks, channelLinkTokens } from '@/src/db/schemas/auth';
import { registryApps } from '@/src/db/schemas/registry';
import { createAppToken, createAppServiceToken, createSessionToken } from '../jwt';
import { POST as speaker } from '@/app/auth/api/channel-link/speaker/route';
import { POST as mint } from '@/app/auth/api/channel-link/agent/route';
import { POST as approve } from '@/app/auth/api/channel-link/approve/route';
import { POST as approveForm } from '@/app/auth/api/channel-link/approve-redirect/route';
import { POST as appMint } from '@/app/auth/api/channel-link/route';
import { GET as appResolve } from '@/app/auth/api/channel-link/resolve/route';
import { POST as verifyToken } from '@/app/auth/api/apps/token/verify/route';
import Page from '@/app/auth/channel-link/[token]/page';

const BOT = 'did:imajin:bot';
const OTHER_BOT = 'did:imajin:other-bot';
const ORG = 'did:imajin:org';
const HUMAN = 'did:imajin:human';
const OTHER_ORG = 'did:imajin:other-org';
const APP = 'did:imajin:app';
const INPUT = { channel: 'telegram', channelUid: 'sender-uid' };
const tables = [identities, identityMembers, delegationGrants, channelLinks, channelLinkTokens, registryApps];
let client: PGlite;
let database: ReturnType<typeof drizzle>;
let credential: string;

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });
beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec('CREATE SCHEMA auth; CREATE SCHEMA registry');
  for (const table of tables) {
    const { schema, name, columns } = getTableConfig(table);
    const fields = columns.map(column => {
      const fallback = column.default === undefined ? '' : ' DEFAULT ' +
        (typeof column.default === 'string' ? `'${column.default}'` : 'NULL');
      return `"${column.name}" ${column.getSQLType()}${fallback}`;
    }).join(',');
    await client.exec(`CREATE TABLE "${schema}"."${name}" (${fields})`);
  }
  await client.exec('CREATE UNIQUE INDEX link_pair ON auth.channel_links(channel, channel_uid, app_did)');
  database = drizzle(client);
  h.db = database;
  h.sql.mockImplementation(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.reduce((text, part, index) => text + part + (index < values.length ? `$${index + 1}` : ''), '');
    return (await client.query(query, values)).rows;
  });
});
afterAll(async () => { await client.close(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await client.exec('TRUNCATE auth.identities, auth.identity_members, auth.delegation_grants, auth.channel_links, auth.channel_link_tokens, registry.apps');
  vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('AUTH_PRIVATE_KEY', '');
  vi.stubEnv('AUTH_SERVICE_URL', 'https://kernel.test/auth');
  h.publish.mockResolvedValue(undefined);
  h.session.mockResolvedValue({ identity: { id: HUMAN, scope: 'actor', subtype: 'human' } });
  h.effective.mockResolvedValue({ sessionDid: HUMAN, effectiveDid: HUMAN });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('https://kernel.test/auth/api/apps/token/verify');
    return verifyToken(new NextRequest(url, init));
  }));
  await database.insert(identities).values([
    { id: BOT, scope: 'actor', subtype: 'agent', publicKey: 'bot-public', name: 'Artifact Bot' },
    { id: OTHER_BOT, scope: 'actor', subtype: 'agent', publicKey: 'other-bot-public' },
    { id: ORG, scope: 'business', publicKey: 'org-public', name: 'Artifact' },
    { id: OTHER_ORG, scope: 'business', publicKey: 'other-org-public' },
    { id: HUMAN, scope: 'actor', subtype: 'human', publicKey: 'human-public' },
  ]);
  await database.insert(identityMembers).values({
    identityDid: ORG, memberDid: BOT, role: 'agent', allowedServices: ['infer'],
  });
  credential = await token();
});

function token(overrides: Partial<Parameters<typeof createAppToken>[0]> = {}) {
  return createAppToken({ sub: BOT, azp: BOT, scope: 'infer:completions', attestationId: randomUUID(), ...overrides });
}
function request(body: unknown = INPUT, headers: Record<string, string> = {}) {
  return new NextRequest('https://kernel.test/auth/api/channel-link/speaker', {
    method: 'POST', headers: { authorization: `Bearer ${credential}`, 'x-acting-as': ORG, ...headers },
    body: JSON.stringify(body),
  });
}
async function member(did = HUMAN, removedAt: Date | null = null, org = ORG) {
  await database.insert(identityMembers).values({ identityDid: org, memberDid: did, role: 'member', removedAt });
}
async function link(appDid = BOT, did = HUMAN, status = 'active', channel = INPUT.channel, channelUid = INPUT.channelUid) {
  await database.insert(channelLinks).values({ id: randomUUID(), ...INPUT, channel, channelUid, appDid, did, status, scopes: ['channel:speaker'] });
}
async function result(expected: { did: string | null; admitted: boolean; reason: string | null }) {
  const response = await speaker(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual(expected);
}

describe('speaker admission and fresh bot-scoped SQL', () => {
  it('returns exactly the linked member result without roles or other member data', async () => {
    await link();
    await member();
    await member(OTHER_ORG);
    await result({ did: HUMAN, admitted: true, reason: null });
    expect(h.publish).not.toHaveBeenCalled();
  });
  it.each(['missing', 'revoked', 'other-bot', 'app', 'wrong-channel', 'wrong-uid'])(
    'returns unknown_sender for %s links', async boundary => {
      if (boundary === 'revoked') await link(BOT, HUMAN, 'revoked');
      if (boundary === 'other-bot') await link(OTHER_BOT);
      if (boundary === 'app') await link(APP);
      if (boundary === 'wrong-channel') await link(BOT, HUMAN, 'active', 'signal');
      if (boundary === 'wrong-uid') await link(BOT, HUMAN, 'active', 'telegram', 'another-uid');
      await member();
      await result({ did: null, admitted: false, reason: 'unknown_sender' });
    },
  );
  it('does not treat another org membership or an assignment grant as sender admission', async () => {
    await link();
    await member(HUMAN, null, OTHER_ORG);
    await database.insert(delegationGrants).values({
      id: randomUUID(), agentDid: HUMAN, delegatorDid: ORG, audience: { type: 'all' },
      issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), status: 'active',
    });
    await result({ did: HUMAN, admitted: false, reason: 'not_member' });
  });
  it('prefers an active row over removed history without consulting sender roles or services', async () => {
    await link();
    await member(HUMAN, new Date());
    await result({ did: HUMAN, admitted: false, reason: 'removed' });
    await database.insert(identityMembers).values({
      identityDid: ORG, memberDid: HUMAN, role: 'member', allowedServices: [],
    });
    await result({ did: HUMAN, admitted: true, reason: null });
  });
  it.each(['presence', 'agent'])('refuses %s senders with or without a membership', async subtype => {
    await link();
    await database.update(identities).set({ subtype }).where(eq(identities.id, HUMAN));
    const expected = { did: HUMAN, admitted: false, reason: `${subtype}_refused` };
    await result(expected);
    await member();
    await result(expected);
  });
  it('observes membership removal and unlink on the very next call', async () => {
    await link();
    await member();
    await result({ did: HUMAN, admitted: true, reason: null });
    await database.update(identityMembers).set({ removedAt: new Date() }).where(eq(identityMembers.memberDid, HUMAN));
    await result({ did: HUMAN, admitted: false, reason: 'removed' });
    await database.update(channelLinks).set({ status: 'revoked', revokedAt: new Date() });
    await result({ did: null, admitted: false, reason: 'unknown_sender' });
  });
  it('separates two bots even when the channel and uid are identical', async () => {
    await link(OTHER_BOT, OTHER_ORG);
    await link();
    await member();
    await result({ did: HUMAN, admitted: true, reason: null });
    credential = await token({ sub: OTHER_BOT, azp: OTHER_BOT });
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: OTHER_BOT, role: 'agent' });
    await result({ did: OTHER_ORG, admitted: false, reason: 'not_member' });
  });
});

describe.each([['speaker', speaker], ['mint', mint]] as const)('%s caller boundaries', (_name, route) => {
  it.each(['unassigned', 'removed', 'wrong-role', 'excluded-service', 'empty-services', 'suspended-bot', 'suspended-org'])(
    'refuses %s on every call', async boundary => {
      if (boundary === 'unassigned') await database.update(identityMembers).set({ identityDid: OTHER_ORG });
      if (boundary === 'removed') await database.update(identityMembers).set({ removedAt: new Date() });
      if (boundary === 'wrong-role') await database.update(identityMembers).set({ role: 'member' });
      if (boundary === 'excluded-service') await database.update(identityMembers).set({ allowedServices: ['warp'] });
      if (boundary === 'empty-services') await database.update(identityMembers).set({ allowedServices: [] });
      if (boundary.startsWith('suspended-')) await database.update(identities).set({ suspendedAt: new Date() })
        .where(eq(identities.id, boundary === 'suspended-bot' ? BOT : ORG));
      const response = await route(request());
      expect(response.status).toBe(403);
      expect(Object.keys(await response.json())).toEqual(['error']);
      expect(await database.select().from(channelLinkTokens)).toEqual([]);
    },
  );
  it.each(['human', 'device', null])('does not let subtype %s borrow an assignment', async subtype => {
    await database.update(identities).set({ subtype }).where(eq(identities.id, BOT));
    expect((await route(request())).status).toBe(403);
  });
  it.each(['missing-org', 'self', 'personal-target', 'unknown-org', 'acting-for'])('refuses %s selectors', async boundary => {
    const req = request();
    if (boundary === 'missing-org') req.headers.delete('x-acting-as');
    if (boundary === 'self') req.headers.set('x-acting-as', BOT);
    if (boundary === 'personal-target') req.headers.set('x-acting-as', HUMAN);
    if (boundary === 'unknown-org') req.headers.set('x-acting-as', 'did:imajin:missing');
    if (boundary === 'acting-for') req.headers.set('x-acting-for', HUMAN);
    expect((await route(req)).status).toBe(403);
  });
  it.each(['borrowed-human', 'org-subject', 'other-app', 'service', 'scope', 'audience', 'bound-acting-for'])(
    'refuses a valid JWT with %s', async boundary => {
      const overrides: Partial<Parameters<typeof createAppToken>[0]> = {};
      if (boundary === 'borrowed-human') overrides.sub = HUMAN;
      if (boundary === 'org-subject') overrides.sub = ORG;
      if (boundary === 'other-app') overrides.azp = APP;
      if (boundary === 'scope') overrides.scope = 'media:read';
      if (boundary === 'audience') overrides.aud = 'other-audience';
      if (boundary === 'bound-acting-for') overrides.actingFor = ORG;
      credential = boundary === 'service'
        ? await createAppServiceToken({ azp: BOT, scope: 'infer:completions' }) : await token(overrides);
      expect((await route(request())).status).toBe(403);
    },
  );
  it.each(['missing', 'tampered', 'session', 'malformed-header'])('rejects %s credentials without session fallback', async boundary => {
    const req = request();
    if (boundary === 'missing') req.headers.delete('authorization');
    if (boundary === 'tampered') req.headers.set('authorization', `Bearer ${credential.split('.').slice(0, 2).join('.')}.${Buffer.alloc(64).toString('base64url')}`);
    if (boundary === 'session') req.headers.set('authorization', `Bearer ${await createSessionToken({ sub: BOT, scope: 'actor', tier: 'soft' })}`);
    if (boundary === 'malformed-header') {
      req.headers.set('authorization', 'Basic invalid');
      req.headers.set('x-api-key', credential);
    }
    expect((await route(req)).status).toBe(401);
    expect(h.session).not.toHaveBeenCalled();
  });
  it('refuses an unknown bot identity even with a matching assignment row', async () => {
    credential = await token({ sub: 'did:imajin:missing', azp: 'did:imajin:missing' });
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: 'did:imajin:missing', role: 'agent' });
    expect((await route(request())).status).toBe(403);
  });
  it('rejects expired JWTs at the real verifier', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await route(request())).status).toBe(401);
  });
  it('never falls back from an invalid bearer to x-api-key', async () => {
    const req = request();
    req.headers.set('authorization', 'Bearer invalid');
    req.headers.set('x-api-key', credential);
    expect((await route(req)).status).toBe(401);
  });
  it('supports x-api-key only when Authorization is absent', async () => {
    const req = request();
    req.headers.delete('authorization');
    req.headers.set('x-api-key', credential);
    expect((await route(req)).status).toBe(_name === 'mint' ? 201 : 200);
  });
  it('uses assignment rather than subtype as authority for a presence caller', async () => {
    await database.update(identities).set({ subtype: 'presence' }).where(eq(identities.id, BOT));
    expect((await route(request())).ok).toBe(true);
    await database.update(identityMembers).set({ removedAt: new Date() });
    expect((await route(request())).status).toBe(403);
  });
  it('uses the canonical live delegation assignment and respects explicit service restrictions', async () => {
    await database.update(identityMembers).set({ identityDid: OTHER_ORG });
    await database.insert(delegationGrants).values({
      id: 'assignment', agentDid: BOT, delegatorDid: ORG, audience: { type: 'dids', values: [ORG] },
      issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), status: 'active',
    });
    expect((await route(request())).ok).toBe(true);
    await database.insert(identityMembers).values({ identityDid: ORG, memberDid: BOT, role: 'agent', allowedServices: [] });
    expect((await route(request())).status).toBe(403);
  });
  it.each([null, [], 'text', {}, { ...INPUT, channel: 'email' }, { ...INPUT, channel: 1 },
    { ...INPUT, channelUid: '' }, { ...INPUT, channelUid: '  ' }, { ...INPUT, channelUid: 42 },
    { ...INPUT, appDid: OTHER_BOT }, { ...INPUT, actingFor: HUMAN }])('rejects invalid body %j', async body => {
    expect((await route(request(body))).status).toBe(400);
    expect(await database.select().from(channelLinkTokens)).toEqual([]);
  });
  it('rejects malformed JSON and trims a valid uid', async () => {
    const malformed = new NextRequest(request().url, { method: 'POST', headers: request().headers, body: '{' });
    expect((await route(malformed)).status).toBe(400);
    expect((await route(request({ ...INPUT, channelUid: ' sender-uid ' }))).ok).toBe(true);
  });
  it('redacts unexpected store failures', async () => {
    const select = vi.spyOn(database, 'select').mockImplementationOnce(() => { throw new Error('private-store-diagnostic'); });
    const response = await route(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Channel link unavailable' });
    select.mockRestore();
  });
});

describe('mint, existing human consent, then resolve/admit', () => {
  it.each(['json', 'form'])('round-trips via %s approval without app registration', async transport => {
    await member();
    await result({ did: null, admitted: false, reason: 'unknown_sender' });
    const response = await mint(request());
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.url).toBe(`https://kernel.test/auth/channel-link/${body.linkToken}`);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    const [stored] = await database.select().from(channelLinkTokens);
    expect(stored.appDid).toBe(BOT);
    expect(stored.requestedScopes).toEqual(['channel:speaker']);
    const page = await Page({ params: Promise.resolve({ token: body.linkToken }), searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(page);
    expect(html).toContain('Artifact Bot');
    expect(html).toContain('check your org membership');
    expect(html).not.toContain('act on your behalf');
    if (transport === 'json') {
      expect((await approve(request({ token: body.linkToken }))).status).toBe(201);
    } else {
      const form = new URLSearchParams({ token: body.linkToken, returnTo: '/auth/settings' });
      expect((await approveForm(new NextRequest(request().url, { method: 'POST', body: form }))).status).toBe(307);
    }
    expect(h.publish).toHaveBeenCalledWith('channel.link.created', expect.objectContaining({ issuer: HUMAN, subject: BOT }));
    expect((await database.select().from(channelLinkTokens))[0].consumedBy).toBe(HUMAN);
    await result({ did: HUMAN, admitted: true, reason: null });
    expect((await approve(request({ token: body.linkToken }))).status).toBe(400);
  });
  it.each(['json', 'form'])('binds the acting org rather than the personal signer via %s approval', async transport => {
    h.session.mockResolvedValue({ identity: { id: HUMAN, scope: 'actor', subtype: 'human', actingAs: OTHER_ORG } });
    h.effective.mockResolvedValue({ sessionDid: HUMAN, effectiveDid: OTHER_ORG });
    const { linkToken } = await (await mint(request())).json();
    if (transport === 'json') await approve(request({ token: linkToken }));
    else await approveForm(new NextRequest(request().url, {
      method: 'POST', body: new URLSearchParams({ token: linkToken, returnTo: '/auth/settings' }),
    }));
    const [binding] = await database.select().from(channelLinks);
    expect(binding.did).toBe(OTHER_ORG);
    expect(h.publish).toHaveBeenCalledWith('channel.link.created', expect.objectContaining({ issuer: OTHER_ORG }));
    await result({ did: OTHER_ORG, admitted: false, reason: 'not_member' });
  });
  it('redacts token insert failures without logging the token or uid', async () => {
    const insert = vi.spyOn(database, 'insert').mockImplementationOnce(() => { throw new Error('private-store-diagnostic'); });
    const response = await mint(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Channel link unavailable' });
    expect(h.log).not.toHaveBeenCalled();
    insert.mockRestore();
  });
  it('falls back to the bot DID rather than a personal session label', async () => {
    const { linkToken } = await (await mint(request())).json();
    await database.update(identities).set({ name: null, handle: null }).where(eq(identities.id, BOT));
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ token: linkToken }), searchParams: Promise.resolve({}) }));
    expect(html).toContain(BOT);
    expect(html).not.toContain(HUMAN);
  });
  it('keeps the registry app label first and falls back to bot handle when unnamed', async () => {
    const { linkToken } = await (await mint(request())).json();
    await database.update(identities).set({ name: null, handle: 'artifact-bot' }).where(eq(identities.id, BOT));
    const props = { params: Promise.resolve({ token: linkToken }), searchParams: Promise.resolve({}) };
    expect(renderToStaticMarkup(await Page(props))).toContain('artifact-bot');
    await database.insert(registryApps).values({ appDid: BOT, name: 'Registry Bot', slug: 'bot', publicKey: 'app-public', ownerDid: ORG });
    expect(renderToStaticMarkup(await Page(props))).toContain('Registry Bot');
  });
  it('rejects expired consent challenges', async () => {
    const { linkToken } = await (await mint(request())).json();
    await database.update(channelLinkTokens).set({ expiresAt: new Date(0) });
    expect((await approve(request({ token: linkToken }))).status).toBe(400);
    expect(renderToStaticMarkup(await Page({ params: Promise.resolve({ token: linkToken }), searchParams: Promise.resolve({}) }))).toContain('Link unavailable');
    await result({ did: null, admitted: false, reason: 'unknown_sender' });
  });
});

describe('unchanged app-auth contract and service documentation', () => {
  it('retains app-auth mint defaults and resolve response, validation, isolation and unlink behavior', async () => {
    credential = await createAppServiceToken({ azp: APP, scope: '' });
    const req = request();
    req.headers.delete('x-acting-as');
    const minted = await appMint(req);
    expect(minted.status).toBe(201);
    const { linkToken } = await minted.json();
    expect((await database.select().from(channelLinkTokens))[0]).toMatchObject({
      appDid: APP, requestedScopes: ['availability:read', 'availability:write'],
    });
    await approve(request({ token: linkToken }));
    const resolve = (query = '?channel=telegram&channelUid=sender-uid') => appResolve(new Request(
      `https://kernel.test/auth/api/channel-link/resolve${query}`, { headers: { authorization: `Bearer ${credential}` } },
    ));
    const response = await resolve();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ did: HUMAN, scopes: ['availability:read', 'availability:write'] });
    expect((await resolve('')).status).toBe(400);
    credential = await createAppServiceToken({ azp: OTHER_BOT, scope: '' });
    expect((await resolve()).status).toBe(404);
    credential = await createAppServiceToken({ azp: APP, scope: '' });
    await database.update(channelLinks).set({ status: 'revoked', revokedAt: new Date() });
    expect(await (await resolve()).json()).toEqual({ error: 'No active channel link found' });
    expect((await appResolve(new Request('https://kernel.test/auth/api/channel-link/resolve'))).status).toBe(401);
  });
  it('documents request/auth/reasons and failures for both new routes and the existing resolve', () => {
    const spec = parseDocument(readFileSync('apps/kernel/api-spec/auth.yaml', 'utf8'));
    expect(spec.errors).toEqual([]);
    const paths = spec.toJS().paths;
    for (const path of ['/api/channel-link/speaker', '/api/channel-link/agent']) {
      const operation = paths[path].post;
      expect(operation.security).toEqual([{ orgBotAuth: [] }]);
      expect(operation.requestBody.content['application/json'].schema.additionalProperties).toBe(false);
      expect(operation.responses['403']).toBeDefined();
    }
    expect(paths['/api/channel-link/speaker'].post.responses['200'].content['application/json'].schema.properties.reason.enum)
      .toEqual([null, 'not_member', 'removed', 'unknown_sender', 'presence_refused', 'agent_refused']);
    expect(paths['/api/channel-link/resolve'].get.responses['200'].content['application/json'].schema.required)
      .toEqual(['did', 'scopes']);
  });
});
