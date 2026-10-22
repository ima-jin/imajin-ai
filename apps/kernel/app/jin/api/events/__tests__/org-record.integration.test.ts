/**
 * #3033 leakage boundary: real route, canonical requireAuth/allowed_services,
 * and real PostgreSQL JSONB/EXISTS/JOIN execution. Only auth HTTP is stubbed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { and, eq, isNull } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { provideInternalApiKey } from '@imajin/auth';
import { SESSION_COOKIE_NAME } from '@imajin/config';
import { identities, identityMembers, delegationGrants } from '@/src/db/schemas/auth';
import { systemEvents } from '@/src/db/schemas/registry';
import { operatorApprovals } from '@/src/db/schemas/operator-approvals';
import { connections } from '@/src/db/schemas/connections';
import { createRecordEventsHarness, type RecordEventsHarness } from '@/src/lib/jin/__tests__/pglite-record-events-harness';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/registry'),
  ...await import('@/src/db/schemas/operator-approvals'),
  get db() { return holder.db; },
}));

import { GET } from '../route';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const ORG = 'did:imajin:org-a';
const OTHER_ORG = 'did:imajin:org-b';
const OWNER = 'did:imajin:owner';
const ADMIN = 'did:imajin:admin';
const MEMBER = 'did:imajin:member';
const COUNTERPARTY = 'did:imajin:counterparty';
const OTHER_OWNER = 'did:imajin:other-owner';
const AGENT = 'did:imajin:shared-agent';
const LEGACY_AGENT = 'did:imajin:legacy-agent';
let harness: RecordEventsHarness;

function request(did: string, actingAs?: string, query = '', actingFor?: string) {
  return new NextRequest(`https://test.imajin.ai/jin/api/events${query}`, {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${did};${actingAs ? ` x-acting-as=${encodeURIComponent(actingAs)}` : ''}`,
      ...(actingFor ? { 'x-acting-for': actingFor } : {}),
    },
  });

}
async function page(did = OWNER, actingAs: string | undefined = ORG, query = '') {
  const response = await GET(request(did, actingAs, query));
  expect(response.status).toBe(200);
  return response.json();
}
function eventIds(body: { events: { id: string }[] }) {
  return body.events.map((event) => event.id).sort((a, b) => a.localeCompare(b));
}
async function snapshot() {
  return {
    events: await harness.db.select().from(systemEvents),
    approvals: await harness.db.select().from(operatorApprovals),
    members: await harness.db.select().from(identityMembers),
    grants: await harness.db.select().from(delegationGrants),
    relationships: await harness.db.select().from(connections),
  };
}
beforeAll(async () => {
  harness = await createRecordEventsHarness();
  holder.db = harness.db;
  for (const table of [connections]) {
    const config = getTableConfig(table);
    const columns = config.columns.map((column) => `"${column.name}" ${column.getSQLType()}`);
    await harness.client.exec(`CREATE SCHEMA IF NOT EXISTS "${config.schema}";
      CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(', ')});`);
  }
});
beforeEach(async () => {
  await harness.client.exec('TRUNCATE auth.identities, auth.identity_members, auth.delegation_grants, registry.system_events, operator.approvals, connections.connections');
  await harness.db.insert(connections).values({
    didA: ORG, didB: COUNTERPARTY, relationshipLabelA: 'client', connectedAt: new Date(),
  });
  await harness.db.insert(identities).values([
    { id: ORG, scope: 'business', publicKey: '' },
    { id: OTHER_ORG, scope: 'business', publicKey: '' },
    ...[OWNER, ADMIN, MEMBER, COUNTERPARTY, OTHER_OWNER].map((id) => ({
      id, scope: 'actor', subtype: 'human', publicKey: '',
    })),
    { id: AGENT, scope: 'actor', subtype: 'agent', publicKey: '' },
  ]);
  await harness.db.insert(identityMembers).values([
    { identityDid: ORG, memberDid: OWNER, role: 'owner' },
    { identityDid: ORG, memberDid: ADMIN, role: 'admin', allowedServices: ['jin'] },
    { identityDid: ORG, memberDid: MEMBER, role: 'member', allowedServices: ['pay'] },
    { identityDid: ORG, memberDid: LEGACY_AGENT, role: 'agent' },
    { identityDid: ORG, memberDid: AGENT, role: 'member' },
    { identityDid: OTHER_ORG, memberDid: OTHER_OWNER, role: 'owner' },
  ]);
  await harness.db.insert(delegationGrants).values([
    { id: 'grant_org', agentDid: AGENT, delegatorDid: ORG, audience: { type: 'all' },
      expiresAt: new Date('2020-01-01'), status: 'revoked', revokedAt: new Date() },
    { id: 'grant_other', agentDid: AGENT, delegatorDid: OTHER_ORG, audience: { type: 'all' },
      expiresAt: new Date('2030-01-01') },
    { id: 'grant_personal', agentDid: AGENT, delegatorDid: OWNER, audience: { type: 'all' },
      expiresAt: new Date('2030-01-01') },
  ]);
  await harness.db.insert(operatorApprovals).values([
    { proposalId: 'approval_org', operatorDid: ORG, source: 'reach', kind: 'reach:message', summary: 'Org decision' },
    { proposalId: 'approval_other', operatorDid: OTHER_ORG, kind: 'reach:message', summary: 'Other org decision' },
  ]);
  const events = [
    { id: 'org', did: ORG },
    { id: 'member_org', did: MEMBER, payload: { actingAs: ORG } },
    { id: 'owner_org', did: OWNER, payload: { actingAs: ORG } },
    { id: 'agent_org', did: AGENT, payload: { grantId: 'grant_org' } },
    { id: 'agent_principal', did: AGENT, payload: { principal: ORG } },
    { id: 'approval_org', did: OWNER, action: 'operator.approval.decided', payload: { proposalId: 'approval_org' } },
    { id: 'personal', did: OWNER },
    { id: 'member_personal', did: MEMBER },
    { id: 'member_other_org', did: MEMBER, payload: { actingAs: OTHER_ORG } },
    { id: 'other_org', did: OTHER_ORG },
    { id: 'agent_other_org', did: AGENT, payload: { grantId: 'grant_other' } },
    { id: 'agent_other_principal', did: AGENT, payload: { principal: OTHER_ORG } },
    { id: 'agent_personal', did: AGENT, payload: { grantId: 'grant_personal' } },
    { id: 'agent_unbound', did: AGENT },
    { id: 'legacy_agent', did: LEGACY_AGENT, payload: { actingAs: ORG, principal: ORG } },
    { id: 'counterparty_claim', did: COUNTERPARTY, payload: { actingAs: ORG } },
    { id: 'approval_other', did: OTHER_OWNER, action: 'operator.approval.decided', payload: { proposalId: 'approval_other' } },
    { id: 'wrong_grant_issuer', did: COUNTERPARTY, payload: { grantId: 'grant_org' } },
    { id: 'wrong_grant_principal', did: AGENT, payload: { grantId: 'grant_other', principal: ORG } },
    { id: 'conflicting_principal', did: AGENT, payload: { grantId: 'grant_org', principal: OTHER_ORG } },
    { id: 'conflicting_act_as', did: AGENT, payload: { grantId: 'grant_org', actingAs: OTHER_ORG } },
    { id: 'agent_member_claim', did: AGENT, payload: { actingAs: ORG } },
    { id: 'unrelated_approval_ref', did: COUNTERPARTY, payload: { proposalId: 'approval_org' } },
  ];
  await harness.db.insert(systemEvents).values(events.map((event, index) => ({
    ...event, service: 'kernel', action: event.action ?? 'test.event',
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)),
  })));
  vi.stubEnv('AUTH_SERVICE_URL', 'https://auth.test/auth');
  provideInternalApiKey('fixture-internal-transport');
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith('/api/session')) {
      const did = (options.headers as { Cookie: string }).Cookie.split('=')[1];
      return Response.json({ did, scope: 'actor', subtype: did === AGENT ? 'agent' : 'human' });
    }
    const match = /\/groups\/([^/]+)\/controllers\/([^/]+)$/.exec(url);
    if (!match) throw new Error('Unexpected auth transport');
    const [row] = await harness.db.select().from(identityMembers).where(and(
      eq(identityMembers.identityDid, decodeURIComponent(match[1])),
      eq(identityMembers.memberDid, decodeURIComponent(match[2])),
      isNull(identityMembers.removedAt),
    ));
    return Response.json({ valid: Boolean(row), role: row?.role, allowedServices: row?.allowedServices });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => { await harness.close(); });

describe('organization Record access and data isolation (#3033)', () => {
  it('uses canonical Inbox addressing for legacy connectors, never the stale stored addressee', async () => {
    await harness.db.insert(operatorApprovals).values([
      { proposalId: 'misrouted_out', operatorDid: ORG, source: 'github', kind: 'github:mutate',
        summary: 'Other owner', detail: { ownerDid: OTHER_ORG } },
      { proposalId: 'misrouted_in', operatorDid: OTHER_ORG, source: 'github', kind: 'github:mutate',
        summary: 'Our owner', detail: { ownerDid: ORG } },
    ]);
    await harness.db.insert(systemEvents).values([
      { id: 'misrouted_out', did: ORG, service: 'kernel', action: 'test.event', payload: { proposalId: 'misrouted_out' } },
      { id: 'misrouted_in', did: ORG, service: 'kernel', action: 'test.event', payload: { proposalId: 'misrouted_in' } },
    ]);
    const body = await page();
    expect(body.events.find((event: { id: string }) => event.id === 'misrouted_out').approvalRef).toBeNull();
    expect(body.events.find((event: { id: string }) => event.id === 'misrouted_in').approvalRef).toMatchObject({
      proposalId: 'misrouted_in', href: '/jin?proposalId=misrouted_in',
    });
  });
  it('does not hydrate another org approval or a foreign/mismatched grant from a visible org-issued row', async () => {
    await harness.db.insert(systemEvents).values([
      { id: 'foreign_refs', did: ORG, service: 'kernel', action: 'test.event',
        payload: { proposalId: 'approval_other', grantId: 'grant_other' } },
      { id: 'wrong_agent_ref', did: OWNER, service: 'kernel', action: 'test.event',
        payload: { actingAs: ORG, grantId: 'grant_org' } },
      { id: 'missing_refs', did: ORG, service: 'kernel', action: 'test.event',
        payload: { proposalId: 'missing', grantId: 'missing' } },
    ]);
    const body = await page();
    for (const id of ['foreign_refs', 'wrong_agent_ref', 'missing_refs']) {
      expect(body.events.find((event: { id: string }) => event.id === id)).toMatchObject({
        approvalRef: null, grantRef: null,
  });
    }
  });
  it('links an agent to the exact revoked grant and addressed approval without copying source data', async () => {
    await harness.db.insert(systemEvents).values({
      id: 'agent_approved', did: AGENT, service: 'kernel', action: 'test.event',
      payload: { grantId: 'grant_org', proposalId: 'approval_org', publisherProof: { signature: 'fixture-proof' } },
    });
    const before = await snapshot();
    const body = await page();
    expect(body.events.find((event: { id: string }) => event.id === 'agent_approved')).toMatchObject({
      kind: 'agent', who: AGENT, grantRef: { grantId: 'grant_org', href: '/auth/api/grants?grantId=grant_org' },
      approvalRef: { proposalId: 'approval_org', source: 'reach', kind: 'reach:message' },
      payload: before.events.find(event => event.id === 'agent_approved')?.payload,
    });
    expect(await snapshot()).toEqual(before);
  });
  const expected = ['agent_org', 'agent_principal', 'approval_org', 'member_org', 'org', 'owner_org'];
  it.each([OWNER, ADMIN])('reads only org-attributed existing rows as %s, without mutations', async (did) => {
    const before = await snapshot();
    const body = await page(did);
    expect(eventIds(body)).toEqual(expected);
    expect(body.total).toBe(expected.length);
    expect(body.events.find((event: { id: string }) => event.id === 'approval_org').approvalRef)
      .toMatchObject({ proposalId: 'approval_org', source: 'reach', kind: 'reach:message', href: '/jin?proposalId=approval_org' });
    for (const row of body.events) {
      expect(row.who).toBe(row.did);
      expect(row.kind).toBe(['org', 'agent_org', 'agent_principal'].includes(row.id) ? 'agent' : 'person');
    }
    expect(body.events.find((event: { id: string }) => event.id === 'agent_org').grantRef)
      .toEqual(did === OWNER ? { grantId: 'grant_org', href: '/auth/api/grants?grantId=grant_org' } : null);
    // principal-only history must not guess which grant was exercised.
    expect(body.events.find((event: { id: string }) => event.id === 'agent_principal').grantRef).toBeNull();
    expect(await snapshot()).toEqual(before);
  });
  it.each([[], ['auth'], ['pay']].map((services) => ({ services })))('denies a controller whose allowed_services is $services', async ({ services }) => {
    await harness.db.update(identityMembers).set({ allowedServices: services }).where(eq(identityMembers.memberDid, ADMIN));
    const response = await GET(request(ADMIN, ORG));
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty('events');
  });
  it.each([MEMBER, COUNTERPARTY, OTHER_OWNER])('denies non-controller %s even with org and agent/grant filters', async (did) => {
    const response = await GET(request(did, ORG, `?agent=${AGENT}&grant=grant_org`));
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty('events');
    const personal = await GET(request(did));
    expect(personal.status).toBe(200);
    expect(eventIds(await personal.json()).filter((id) => expected.includes(id))).toEqual([]);
  });
  it('never derives org visibility from X-Acting-For alone or mixed with act-as', async () => {
    // Even valid delegation cannot select the org read principal.
    const fetchMock = vi.mocked(fetch);
    const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, options) => String(url).includes('/controllers/')
      ? Response.json({ valid: true, role: 'agent' }) : transport(url, options));
    const delegated = await GET(request(AGENT, undefined, '', ORG));
    expect(delegated.status).toBe(200);
    expect(eventIds(await delegated.json()).filter((id) => expected.includes(id))).toEqual([]);
    const response = await GET(request(AGENT, ORG, '', ORG));
    expect(response.status).toBe(403);
  });
  it('preserves the same owner personal record without org rows', async () => {
    const personal = await GET(request(OWNER));
    expect(personal.status).toBe(200);
    const body = await personal.json();
    expect(eventIds(body)).toEqual(['agent_personal', 'agent_unbound', 'personal']);
    expect(body.total).toBe(3);
  });
  it('retains attributed history after a member is removed without granting them read authority', async () => {
    await harness.db.update(identityMembers).set({ removedAt: new Date() }).where(eq(identityMembers.memberDid, MEMBER));
    expect(eventIds(await page())).toEqual(expected);
    expect((await GET(request(MEMBER, ORG))).status).toBe(403);
  });
  it('denies agent membership even when it is mislabeled as a human controller', async () => {
    await harness.db.update(identityMembers).set({ role: 'owner' }).where(eq(identityMembers.memberDid, AGENT));
    expect((await GET(request(AGENT, ORG))).status).toBe(403);
    expect(eventIds(await page())).toEqual(expected);
  });
  it('revoking the reader membership takes effect on the next call', async () => {
    await page(ADMIN);
    await harness.db.update(identityMembers).set({ removedAt: new Date() }).where(eq(identityMembers.memberDid, ADMIN));
    expect((await GET(request(ADMIN, ORG))).status).toBe(403);
  });
  it('keeps filters, pagination and totals within the organization boundary', async () => {
    const body = await page(OWNER, ORG, `?agent=${AGENT}&limit=1&offset=1`);
    expect(eventIds(body)).toEqual(['agent_org']);
    expect(body.total).toBe(2);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(1);
    expect((await page(OWNER, ORG, '?grant=grant_other')).total).toBe(0);
    expect((await page(OWNER, ORG, `?agent=${OTHER_OWNER}`)).events).toEqual([]);
    expect((await page(OWNER, ORG, '?action=operator.approval.decided')).total).toBe(1);
    expect((await page(OWNER, ORG, '?since=2026-10-01T00:00:05Z')).total).toBe(1);
  });
});
