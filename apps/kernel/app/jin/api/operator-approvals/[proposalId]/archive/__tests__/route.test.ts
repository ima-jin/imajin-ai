import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/src/lib/notify/reach-approvals', () => ({ backfillReachApprovals: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/notify/reach-approval-authority', () => ({ reachActAsPrincipal: vi.fn().mockResolvedValue(null) }));
import { eq, sql } from 'drizzle-orm';
import {
  AGENT_DID,
  OPERATOR_DID,
  OTHER_HUMAN_DID,
  PROPOSAL_ID,
  agentActingForOperatorIdentity,
  operatorActingAsGroupIdentity,
  operatorIdentity,
  otherHumanIdentity,
} from '@/src/lib/notify/__tests__/operator-approvals-test-helpers';
import {
  installConnectorInboxHarness,
  seedApproval,
} from '@/src/lib/notify/__tests__/pglite-connector-inbox-harness';

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  requireAuth: vi.fn(),
  publish: vi.fn(),
  sign: vi.fn(),
}));

vi.mock('@/src/db', async () => {
  const { forwardingDb } = await import('@/src/lib/notify/__tests__/pglite-connector-inbox-harness');
  const { operatorApprovals } = await import('@/src/db/schemas/operator-approvals');
  return { db: forwardingDb(() => mocks.db), operatorApprovals, identities: {} };
});
vi.mock('@imajin/auth', async () => {
  const actual = await vi.importActual<typeof import('@imajin/auth')>('@imajin/auth');
  return { ...actual, requireAuth: mocks.requireAuth };
});
vi.mock('@imajin/bus', () => ({ publish: mocks.publish }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers({ 'access-control-allow-origin': 'https://test.imajin.ai' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeSelfInfo: async () => ({ nodeOperatorDid: OPERATOR_DID }),
}));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: mocks.sign }));
vi.mock('@/src/lib/notify/web-push', () => ({ pushWebNotificationToOperator: vi.fn() }));

import { POST, OPTIONS } from '../route';
import { GET } from '../../../route';
import { operatorApprovals } from '@/src/db/schemas/operator-approvals';
import { archiveOperatorApproval, listApprovalsForOperator } from '@/src/lib/notify/operator-approvals-service';

const harness = installConnectorInboxHarness(mocks);
const OTHER_MARKER = '2026-09-01T00:00:00.000Z';
const FIRST_MARKER = '2026-10-16T23:00:00.000Z';

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: operatorIdentity() });
  await harness.db.delete(operatorApprovals);
});

type Identity = ReturnType<typeof operatorIdentity>;

async function postAs(identity: Identity = operatorIdentity(), id = PROPOSAL_ID) {
  mocks.requireAuth.mockResolvedValueOnce({ identity });
  return post(id);
}

function post(id = PROPOSAL_ID) {
  const request = new Request(`https://test.imajin.ai/jin/api/operator-approvals/${id}/archive`, {
    method: 'POST',
  });
  return POST(request as Parameters<typeof POST>[0], { params: Promise.resolve({ proposalId: id }) });
}

async function inboxAs(identity: Identity = operatorIdentity()) {
  mocks.requireAuth.mockResolvedValueOnce({ identity });
  const response = await GET(new Request('https://test.imajin.ai/jin/api/operator-approvals') as Parameters<typeof GET>[0]);
  return response.json();
}

async function seed(overrides: Partial<typeof operatorApprovals.$inferInsert> = {}) {
  await seedApproval(harness.db, {
    proposalId: PROPOSAL_ID,
    source: 'decision',
    kind: 'decision:card',
    status: 'approved',
    detail: { subject: 'a/b#2694', options: [{ label: 'A', description: 'Keep it' }] },
    contentHash: 'a'.repeat(64),
    decision: { payload: { decision: 'approve', mode: 'A' }, signature: 'signed-original' },
    ...overrides,
  });
}

async function row() {
  const [stored] = await harness.db.select().from(operatorApprovals).where(eq(operatorApprovals.proposalId, PROPOSAL_ID));
  return stored;
}
/** Run an independent writer between the service's load and atomic update. */
function beforeArchiveWrite(effect: () => Promise<unknown>) {
  const realUpdate = harness.db.update.bind(harness.db);
  const updateSpy = vi.spyOn(harness.db, 'update').mockImplementationOnce((table) => {
    const update = realUpdate(table);
    const realSet = update.set.bind(update);
    vi.spyOn(update, 'set').mockImplementationOnce((values) => {
      const query = realSet(values);
      const realReturning = query.returning.bind(query);
      vi.spyOn(query, 'returning').mockImplementationOnce((fields) => {
        updateSpy.mockRestore();
        return effect().then(realReturning.bind(query, fields)) as unknown as ReturnType<typeof query.returning>;
      });
      return query;
    });
    return update;
  });
}

describe('durable decision-card archive (#2694)', () => {
  it('persists through fresh GETs on another device without changing or deleting the proposal', async () => {
    await seed({ outcome: { existingMetadata: { keep: true }, inboxArchivedBy: { [OTHER_HUMAN_DID]: OTHER_MARKER } } });
    const before = await row();

    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://test.imajin.ai');
    const after = await row();
    const archivedAt = (after.outcome?.inboxArchivedBy as Record<string, string>)[OPERATOR_DID];
    expect(new Date(archivedAt).toISOString()).toBe(archivedAt);
    // Every column except the unsigned outcome is byte-for-byte unchanged.
    expect({ ...after, outcome: before.outcome }).toEqual(before);
    expect(after.outcome).toEqual({
      existingMetadata: { keep: true },
      inboxArchivedBy: { [OTHER_HUMAN_DID]: OTHER_MARKER, [OPERATOR_DID]: archivedAt },
    });
    for (let device = 0; device < 2; device++) {
      const inbox = await inboxAs();
      expect(inbox.approvals).toHaveLength(1);
      expect(inbox.approvals[0].archivedAt).toBe(archivedAt);
      expect(inbox.approvals[0].outcome).toEqual({ existingMetadata: { keep: true } });
      expect(JSON.stringify(inbox)).not.toContain(OTHER_MARKER);
    }
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it.each(['approved', 'denied', 'withdrawn', 'applied', 'expired'])('archives %s cards, including null outcome', async (status) => {
    await seed({ status, appliedAt: status === 'applied' ? new Date(FIRST_MARKER) : null });
    const before = await row();
    expect((await post()).status).toBe(200);
    const stored = await row();
    expect({ ...stored, outcome: before.outcome }).toEqual(before);
    const [card] = await listApprovalsForOperator(OPERATOR_DID);
    expect(card.archivedAt).toEqual(expect.any(String));
    expect(card.outcome).toBeNull();
  });

  it('retains the first timestamp across retries and concurrent requests', async () => {
    await seed({ outcome: { inboxArchivedBy: { [OPERATOR_DID]: FIRST_MARKER } } });
    const responses = await Promise.all([post(), post(), post()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect((await listApprovalsForOperator(OPERATOR_DID))[0].archivedAt).toBe(FIRST_MARKER);
  });

  it('merges against live JSONB, not a stale loaded outcome', async () => {
    await seed();
    beforeArchiveWrite(async () => {
      await harness.db.update(operatorApprovals).set({
        outcome: sql`jsonb_build_object('concurrentMetadata', true, 'inboxArchivedBy',
          jsonb_build_object(${OTHER_HUMAN_DID}::text, ${OTHER_MARKER}::text))`,
      }).where(eq(operatorApprovals.proposalId, PROPOSAL_ID));
    });

    expect(await archiveOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID })).toEqual({ ok: true });
    expect((await row()).outcome).toEqual({
      concurrentMetadata: true,
      inboxArchivedBy: { [OTHER_HUMAN_DID]: OTHER_MARKER, [OPERATOR_DID]: expect.any(String) },
    });
  });
  it('fails closed if the proposal becomes pending between the load and write', async () => {
    await seed();
    beforeArchiveWrite(async () => {
      await harness.db.update(operatorApprovals).set({ status: 'pending' })
        .where(eq(operatorApprovals.proposalId, PROPOSAL_ID));
    });
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Proposal changed before it could be archived' });
    expect((await row()).outcome).toBeNull();
  });

  it.each([null, 'not-an-object', { [OPERATOR_DID]: 123 }])('ignores malformed markers on reads and repairs them on archive: %j', async (inboxArchivedBy) => {
    await seed({ outcome: { inboxArchivedBy } });
    expect((await listApprovalsForOperator(OPERATOR_DID))[0].archivedAt).toBeNull();
    expect((await post()).status).toBe(200);
    expect((await listApprovalsForOperator(OPERATOR_DID))[0].archivedAt).toEqual(expect.any(String));
  });

  it('does not expose another DID marker or let it affect this reader’s visibility', async () => {
    await seed({ outcome: { inboxArchivedBy: { [OTHER_HUMAN_DID]: OTHER_MARKER } } });
    const inbox = await inboxAs();
    expect(inbox.approvals).toHaveLength(1);
    expect(inbox.approvals[0].archivedAt).toBeNull();
    expect(inbox.approvals[0].outcome).toBeNull();
    expect((await inboxAs(otherHumanIdentity())).approvals).toEqual([]);
    expect((await postAs(otherHumanIdentity())).status).toBe(403);
    expect((await row()).outcome).toEqual({ inboxArchivedBy: { [OTHER_HUMAN_DID]: OTHER_MARKER } });
  });

  it('scopes decision cards to their stored addressee, not detail.ownerDid or the node operator', async () => {
    await seed({ operatorDid: OTHER_HUMAN_DID, detail: { ownerDid: OPERATOR_DID } });
    expect((await post()).status).toBe(403);
    expect((await inboxAs()).approvals).toEqual([]);
    expect((await postAs(otherHumanIdentity())).status).toBe(200);
    expect((await inboxAs(otherHumanIdentity())).approvals[0].archivedAt).toEqual(expect.any(String));
  });

  it.each([
    { status: 'pending' },
    { status: 'unknown' },
    { source: 'exec', kind: 'exec.command' },
    { source: 'github', kind: 'github:mutate', detail: { ownerDid: OPERATOR_DID } },
    { source: 'other', kind: 'decision:card' },
    { kind: 'decision:other' },
  ])('refuses non-archivable rows without mutation: %j', async (overrides) => {
    await seed(overrides);
    const before = await row();
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Only decided decision cards may be archived' });
    expect(await row()).toEqual(before);
  });

  it('returns a missing-proposal error', async () => {
    const response = await post();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Proposal not found' });
  });
});

describe('archive auth and error contract', () => {
  it('requires authentication', async () => {
    mocks.requireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const response = await post();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it.each([operatorActingAsGroupIdentity(), agentActingForOperatorIdentity()])('refuses borrowed identity before looking up any proposal: %j', async (identity) => {
    const lookup = vi.spyOn(harness.db, 'select');
    const response = await postAs(identity, 'nonexistent');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'act_as_not_permitted' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses delegation even when actingFor names the same DID', async () => {
    const identity = { ...operatorIdentity(), actingFor: OPERATOR_DID };
    const response = await postAs(identity);
    expect(response.status).toBe(403);
    expect(await response.json()).toHaveProperty('error');
  });

  it('does not give an agent another principal’s write authority', async () => {
    await seed();
    const response = await postAs({ id: AGENT_DID, scope: 'actor', subtype: 'agent' });
    expect(response.status).toBe(403);
    expect((await row()).outcome).toBeNull();
  });

  it('returns sanitized JSON on persistence failure', async () => {
    await seed();
    vi.spyOn(harness.db, 'update').mockImplementationOnce(() => { throw new Error('private database detail'); });
    const response = await post();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to archive proposal' });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://test.imajin.ai');
    expect((await row()).outcome).toBeNull();
  });

  it('exports the shared OPTIONS handler', async () => {
    expect((await OPTIONS()).status).toBe(204);
  });
});
