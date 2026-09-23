/**
 * Real-engine coverage for the Record lane read model (#2289), via
 * `createRecordEventsHarness()`. See that harness's docblock for why
 * these scoping/join assertions need a real Postgres engine rather than a
 * mocked Drizzle executor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRecordEventsHarness,
  type RecordEventsHarness,
} from './pglite-record-events-harness';

const dbHolder: { current: unknown } = { current: null };

vi.mock('@/src/db', async () => {
  const registry = await import('@/src/db/schemas/registry');
  const operatorApprovalsSchema = await import('@/src/db/schemas/operator-approvals');
  const authSchema = await import('@/src/db/schemas/auth');
  return {
    get db() {
      return dbHolder.current;
    },
    systemEvents: registry.systemEvents,
    operatorApprovals: operatorApprovalsSchema.operatorApprovals,
    identityMembers: authSchema.identityMembers,
    delegationGrants: authSchema.delegationGrants,
  };
});

import { listRecordEventsForPrincipal, resolveOwnedAgentDids } from '../record-events';

const PRINCIPAL_A = 'did:imajin:principal-a';
const PRINCIPAL_B = 'did:imajin:principal-b';

let harness: RecordEventsHarness;

beforeEach(async () => {
  harness = await createRecordEventsHarness();
  dbHolder.current = harness.db;
});

afterEach(async () => {
  await harness.close();
  dbHolder.current = null;
});

async function insertEvent(overrides: {
  id: string;
  did?: string | null;
  action?: string;
  payload?: Record<string, unknown> | null;
  createdAt?: Date;
}) {
  const { systemEvents } = await import('@/src/db/schemas/registry');
  await harness.db.insert(systemEvents).values({
    id: overrides.id,
    service: 'kernel',
    action: overrides.action ?? 'test.event',
    did: overrides.did ?? null,
    payload: overrides.payload ?? null,
    createdAt: overrides.createdAt ?? new Date(),
  });
}

async function insertApproval(overrides: { proposalId: string; operatorDid: string; source?: string; kind?: string }) {
  const { operatorApprovals } = await import('@/src/db/schemas/operator-approvals');
  await harness.db.insert(operatorApprovals).values({
    proposalId: overrides.proposalId,
    operatorDid: overrides.operatorDid,
    source: overrides.source ?? 'vault',
    kind: overrides.kind ?? 'vault:mint',
    summary: 'test approval',
  });
}

async function insertLegacyAgentMembership(identityDid: string, memberDid: string) {
  const { identityMembers } = await import('@/src/db/schemas/auth');
  await harness.db.insert(identityMembers).values({ identityDid, memberDid, role: 'agent' });
}

async function insertDelegationGrant(delegatorDid: string, agentDid: string, opts: { revoked?: boolean } = {}) {
  const { delegationGrants } = await import('@/src/db/schemas/auth');
  await harness.db.insert(delegationGrants).values({
    id: `grant_${agentDid}`,
    agentDid,
    delegatorDid,
    audience: { type: 'all' },
    expiresAt: new Date(Date.now() + 60_000),
    status: opts.revoked ? 'revoked' : 'active',
    revokedAt: opts.revoked ? new Date() : null,
  });
}

describe('resolveOwnedAgentDids (#2289)', () => {
  it('unions legacy role=agent membership with #1882 delegation grants, deduped', async () => {
    await insertLegacyAgentMembership(PRINCIPAL_A, 'did:imajin:agent-legacy');
    await insertDelegationGrant(PRINCIPAL_A, 'did:imajin:agent-grant');
    await insertDelegationGrant(PRINCIPAL_A, 'did:imajin:agent-legacy'); // same agent via both paths

    const dids = await resolveOwnedAgentDids(PRINCIPAL_A);
    expect(new Set(dids)).toEqual(new Set(['did:imajin:agent-legacy', 'did:imajin:agent-grant']));
  });

  it('still returns an agent DID whose delegation grant has since been revoked (history is not forgotten)', async () => {
    await insertDelegationGrant(PRINCIPAL_A, 'did:imajin:agent-revoked', { revoked: true });
    const dids = await resolveOwnedAgentDids(PRINCIPAL_A);
    expect(dids).toContain('did:imajin:agent-revoked');
  });

  it('returns nothing for a principal with no agents', async () => {
    const dids = await resolveOwnedAgentDids(PRINCIPAL_A);
    expect(dids).toEqual([]);
  });
});

describe('listRecordEventsForPrincipal — scoping (#2289 acceptance)', () => {
  it('principal A never sees principal B events (issuer isolation)', async () => {
    await insertEvent({ id: 'evt_a', did: PRINCIPAL_A });
    await insertEvent({ id: 'evt_b', did: PRINCIPAL_B });

    const pageA = await listRecordEventsForPrincipal(PRINCIPAL_A);
    expect(pageA.events.map((e) => e.id)).toEqual(['evt_a']);

    const pageB = await listRecordEventsForPrincipal(PRINCIPAL_B);
    expect(pageB.events.map((e) => e.id)).toEqual(['evt_b']);
  });

  it('a principal sees events issued by an agent delegated to them via legacy identity_members', async () => {
    await insertLegacyAgentMembership(PRINCIPAL_A, 'did:imajin:agent-1');
    await insertEvent({ id: 'evt_agent1', did: 'did:imajin:agent-1' });
    await insertEvent({ id: 'evt_stranger', did: 'did:imajin:someone-else' });

    const page = await listRecordEventsForPrincipal(PRINCIPAL_A);
    expect(page.events.map((e) => e.id)).toEqual(['evt_agent1']);
  });

  it('a principal sees events issued by an agent they hold a #1882 delegation grant for', async () => {
    await insertDelegationGrant(PRINCIPAL_A, 'did:imajin:agent-2');
    await insertEvent({ id: 'evt_agent2', did: 'did:imajin:agent-2' });

    const page = await listRecordEventsForPrincipal(PRINCIPAL_A);
    expect(page.events.map((e) => e.id)).toEqual(['evt_agent2']);
  });

  it('a principal never sees another principal\u2019s owned-agent events', async () => {
    await insertDelegationGrant(PRINCIPAL_B, 'did:imajin:agent-b-owned');
    await insertEvent({ id: 'evt_b_agent', did: 'did:imajin:agent-b-owned' });

    const page = await listRecordEventsForPrincipal(PRINCIPAL_A);
    expect(page.events).toHaveLength(0);
  });

  it('a principal sees an event decided by them via the operator-approval join, even when the event\u2019s own issuer is a different DID', async () => {
    await insertApproval({ proposalId: 'prop_1', operatorDid: PRINCIPAL_A, source: 'vault', kind: 'vault:mint' });
    await insertEvent({
      id: 'evt_decided',
      did: 'did:imajin:node', // issuer differs from the deciding operator
      action: 'operator.approval.decided',
      payload: { proposalId: 'prop_1', decidedBy: PRINCIPAL_A },
    });

    const page = await listRecordEventsForPrincipal(PRINCIPAL_A);
    expect(page.events.map((e) => e.id)).toEqual(['evt_decided']);

    const other = await listRecordEventsForPrincipal(PRINCIPAL_B);
    expect(other.events).toHaveLength(0);
  });
});

describe('listRecordEventsForPrincipal — approvalRef join (#2289 acceptance)', () => {
  it('populates approvalRef {proposalId, source, kind} when the join matches', async () => {
    await insertApproval({ proposalId: 'prop_2', operatorDid: PRINCIPAL_A, source: 'access', kind: 'access:bearer-grant' });
    await insertEvent({
      id: 'evt_with_ref',
      did: PRINCIPAL_A,
      action: 'operator.approval.decided',
      payload: { proposalId: 'prop_2' },
    });

    const page = await listRecordEventsForPrincipal(PRINCIPAL_A);
    expect(page.events[0].approvalRef).toEqual({ proposalId: 'prop_2', source: 'access', kind: 'access:bearer-grant' });
  });

  it('leaves approvalRef null when the event carries no matching proposalId', async () => {
    await insertEvent({ id: 'evt_no_ref', did: PRINCIPAL_A, payload: { foo: 'bar' } });

    const page = await listRecordEventsForPrincipal(PRINCIPAL_A);
    expect(page.events[0].approvalRef).toBeNull();
  });

  it('reports hasOperatorSignature true only when payload.operatorSignature is present', async () => {
    await insertEvent({
      id: 'evt_signed',
      did: PRINCIPAL_A,
      payload: { operatorSignature: { keyId: 'k', alg: 'ed25519', sig: 's' } },
    });
    await insertEvent({ id: 'evt_unsigned', did: PRINCIPAL_A, payload: { foo: 'bar' } });

    const page = await listRecordEventsForPrincipal(PRINCIPAL_A);
    const byId = Object.fromEntries(page.events.map((e) => [e.id, e]));
    expect(byId.evt_signed.hasOperatorSignature).toBe(true);
    expect(byId.evt_unsigned.hasOperatorSignature).toBe(false);
  });
});

describe('listRecordEventsForPrincipal — filters (#2289 acceptance)', () => {
  it('filters by action', async () => {
    await insertEvent({ id: 'evt_kind_a', did: PRINCIPAL_A, action: 'vault.key.minted' });
    await insertEvent({ id: 'evt_kind_b', did: PRINCIPAL_A, action: 'vault.key.revoked' });

    const page = await listRecordEventsForPrincipal(PRINCIPAL_A, { action: 'vault.key.minted' });
    expect(page.events.map((e) => e.id)).toEqual(['evt_kind_a']);
  });

  it('filters by since (inclusive lower bound)', async () => {
    await insertEvent({ id: 'evt_old', did: PRINCIPAL_A, createdAt: new Date('2026-01-01T00:00:00Z') });
    await insertEvent({ id: 'evt_new', did: PRINCIPAL_A, createdAt: new Date('2026-06-01T00:00:00Z') });

    const page = await listRecordEventsForPrincipal(PRINCIPAL_A, { since: '2026-03-01T00:00:00Z' });
    expect(page.events.map((e) => e.id)).toEqual(['evt_new']);
  });

  it('an agent filter only narrows within scope — cannot be used to see a non-owned DID\u2019s events', async () => {
    await insertDelegationGrant(PRINCIPAL_A, 'did:imajin:agent-owned');
    await insertEvent({ id: 'evt_owned', did: 'did:imajin:agent-owned' });
    await insertEvent({ id: 'evt_self', did: PRINCIPAL_A });

    const narrowed = await listRecordEventsForPrincipal(PRINCIPAL_A, { agent: 'did:imajin:agent-owned' });
    expect(narrowed.events.map((e) => e.id)).toEqual(['evt_owned']);

    const attemptEscalation = await listRecordEventsForPrincipal(PRINCIPAL_A, { agent: PRINCIPAL_B });
    expect(attemptEscalation.events).toHaveLength(0);
  });

  it('filters by grant id via payload.grantId', async () => {
    await insertEvent({ id: 'evt_grant_x', did: PRINCIPAL_A, payload: { grantId: 'grant_x' } });
    await insertEvent({ id: 'evt_grant_y', did: PRINCIPAL_A, payload: { grantId: 'grant_y' } });

    const page = await listRecordEventsForPrincipal(PRINCIPAL_A, { grant: 'grant_x' });
    expect(page.events.map((e) => e.id)).toEqual(['evt_grant_x']);
  });
});

describe('listRecordEventsForPrincipal — pagination (#2289 acceptance)', () => {
  it('orders newest-first and honors bounded limit+offset, with an accurate total', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      await insertEvent({ id: `evt_${i}`, did: PRINCIPAL_A, createdAt: new Date(base + i * 1000) });
    }

    const page1 = await listRecordEventsForPrincipal(PRINCIPAL_A, { limit: 2, offset: 0 });
    expect(page1.events.map((e) => e.id)).toEqual(['evt_4', 'evt_3']);
    expect(page1.total).toBe(5);

    const page2 = await listRecordEventsForPrincipal(PRINCIPAL_A, { limit: 2, offset: 2 });
    expect(page2.events.map((e) => e.id)).toEqual(['evt_2', 'evt_1']);
    expect(page2.total).toBe(5);
  });

  it('clamps an out-of-range limit to the maximum instead of erroring', async () => {
    await insertEvent({ id: 'evt_solo', did: PRINCIPAL_A });
    const page = await listRecordEventsForPrincipal(PRINCIPAL_A, { limit: 10_000 });
    expect(page.limit).toBe(200);
  });

  it('falls back to the default limit for a non-positive or missing limit', async () => {
    await insertEvent({ id: 'evt_solo2', did: PRINCIPAL_A });
    const page = await listRecordEventsForPrincipal(PRINCIPAL_A, { limit: -5 });
    expect(page.limit).toBe(50);
  });
});
