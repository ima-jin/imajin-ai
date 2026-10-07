/**
 * #2723 acceptance, at the ROUTE level over a real Postgres engine (pglite):
 * a connector proposal is addressed to its owner, so
 *   - the owner sees it in their Inbox and can approve it (the ledger the
 *     write gate reads flips to `approved`),
 *   - the node operator does not see it, and their confirm/deny is refused,
 *   - act-as can't reach it,
 *   - node-level kinds still go to the operator, unchanged,
 *   - notifications go to the owner.
 * Only the edges are faked (auth, bus, web push, vault/access/apps execution,
 * node identity); the routes, the service and the github execution bridge are
 * all real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTOR_OWNER_DID,
  GROUP_DID,
  OPERATOR_DID,
  agentActingForOperatorIdentity,
  connectorOwnerIdentity,
  githubProposalDetail,
  operatorIdentity,
} from '@/src/lib/notify/__tests__/operator-approvals-test-helpers';
import {
  installConnectorInboxHarness,
  seedApproval,
  seedLedgerRow,
} from '@/src/lib/notify/__tests__/pglite-connector-inbox-harness';

// ─── Mocks (edges only) ──────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  requireAuth: vi.fn(),
  publish: vi.fn(),
  pushWeb: vi.fn(),
}));

vi.mock('@/src/db', async () => {
  const { forwardingDb } = await import('@/src/lib/notify/__tests__/pglite-connector-inbox-harness');
  const { operatorApprovals } = await import('@/src/db/schemas/operator-approvals');
  const { githubActionProposals } = await import('@/src/db/schemas/github');
  // The harness db is created in beforeAll; forward every access to it lazily.
  const db = forwardingDb(() => mocks.db);
  return { db, operatorApprovals, githubActionProposals, identities: {} };
});

vi.mock('@imajin/auth', async () => {
  const actual = await vi.importActual<typeof import('@imajin/auth')>('@imajin/auth');
  return { ...actual, requireAuth: mocks.requireAuth };
});
vi.mock('@imajin/bus', () => ({ publish: mocks.publish }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeSelfInfo: async () => ({ nodeOperatorDid: OPERATOR_DID }),
}));
vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({ privateKeyHex: 'a'.repeat(64), senderPubkey: 'b'.repeat(64) }),
}));
vi.mock('@/src/lib/notify/web-push', () => ({ pushWebNotificationToOperator: mocks.pushWeb }));
vi.mock('@/src/lib/vault/approvals-execution', () => ({ executeVaultApproval: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('@/src/lib/access/approvals-execution', () => ({ executeAccessApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }) }));
vi.mock('@/src/lib/apps/approvals-execution', () => ({ executeAppsProvisionApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }) }));

// ─── Subject (real routes, service and github execution bridge) ──────────────

import { GET } from '../route';
import { POST } from '../[proposalId]/decision/route';
import { recordApprovalRequested } from '@/src/lib/notify/operator-approvals-service';
import { computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import { operatorApprovals } from '@/src/db/schemas/operator-approvals';
import { githubActionProposals } from '@/src/db/schemas/github';
import { eq } from 'drizzle-orm';

type Identity = ReturnType<typeof operatorIdentity>;

const OWNER_PROPOSAL = 'proposal_eric_1';
const OPERATOR_OWN_PROPOSAL = 'proposal_ryan_1';
const GATEWAY_PROPOSAL = 'opap_gateway_1';

const harness = installConnectorInboxHarness(mocks);

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.publish.mockResolvedValue(undefined);
  mocks.pushWeb.mockResolvedValue(undefined);
  await harness.db.delete(operatorApprovals);
  await harness.db.delete(githubActionProposals);
});

/** Raise a proposal the way every producer does: through `recordApprovalRequested`, defaulting the addressee to the node operator. */
async function raise(proposalId: string, source: string, kind: string, detail: Record<string, unknown> | null) {
  const summary = 'a proposal';
  await recordApprovalRequested({
    proposalId,
    operatorDid: OPERATOR_DID,
    source,
    kind,
    summary,
    keysTouched: [],
    detail,
    contentHash: computeApprovalContentHash({ proposalId, source, kind, summary, keysTouched: [], detail }),
    notificationId: null,
    signerDid: null,
  });
}

async function raiseGithub(proposalId: string, ownerDid: string) {
  await seedLedgerRow(harness.db, proposalId, ownerDid);
  await raise(proposalId, 'github', 'github:mutate', githubProposalDetail(ownerDid));
}

/** The pre-#2723 misroute: Eric's proposal, stored under the node operator. */
async function seedLegacyOwnerProposal() {
  await seedLedgerRow(harness.db, OWNER_PROPOSAL, CONNECTOR_OWNER_DID);
  await seedApproval(harness.db, { proposalId: OWNER_PROPOSAL });
}

async function inboxOf(identity: Identity): Promise<{ isOperator: boolean; approvals: Array<{ proposalId: string; operatorDid: string }> }> {
  mocks.requireAuth.mockResolvedValueOnce({ identity });
  const res = await GET(new Request('https://test.imajin.ai/jin/api/operator-approvals') as Parameters<typeof GET>[0]);
  return res.json();
}

async function decide(identity: Identity, proposalId: string, decision: 'approve' | 'reject' = 'approve') {
  mocks.requireAuth.mockResolvedValueOnce({ identity });
  const req = new Request(`https://test.imajin.ai/jin/api/operator-approvals/${proposalId}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  });
  return POST(req as Parameters<typeof POST>[0], { params: Promise.resolve({ proposalId }) });
}

async function ledgerStatus(id: string): Promise<string | undefined> {
  const [row] = await harness.db.select().from(githubActionProposals).where(eq(githubActionProposals.id, id));
  return row?.status;
}

async function approvalRow(id: string) {
  const [row] = await harness.db.select().from(operatorApprovals).where(eq(operatorApprovals.proposalId, id));
  return row;
}

const proposalIds = (inbox: { approvals: Array<{ proposalId: string }> }) => inbox.approvals.map((a) => a.proposalId);

// ─── Acceptance ──────────────────────────────────────────────────────────────

describe('connector proposal: the owner sees it and approves it (#2723)', () => {
  it("lands in the owner's Inbox, addressed to them", async () => {
    await raiseGithub(OWNER_PROPOSAL, CONNECTOR_OWNER_DID);

    const inbox = await inboxOf(connectorOwnerIdentity());

    expect(proposalIds(inbox)).toEqual([OWNER_PROPOSAL]);
    expect(inbox.approvals[0].operatorDid).toBe(CONNECTOR_OWNER_DID);
    expect((await approvalRow(OWNER_PROPOSAL)).operatorDid).toBe(CONNECTOR_OWNER_DID);
  });

  it.each([
    ['approve', 'approved', 'approved', 'action.approved'],
    ['reject', 'denied', 'denied', 'action.denied'],
  ] as const)(
    'the owner deciding %s flips the approval to %s and the write-gate ledger to %s',
    async (decision, approvalStatus, expectedLedger, busEvent) => {
      await raiseGithub(OWNER_PROPOSAL, CONNECTOR_OWNER_DID);

      const res = await decide(connectorOwnerIdentity(), OWNER_PROPOSAL, decision);
      const body = (await res.json()) as { approval: { status: string }; executionError?: string };

      expect(res.status).toBe(200);
      expect(body.executionError).toBeUndefined();
      expect(body.approval.status).toBe(approvalStatus);
      expect(await ledgerStatus(OWNER_PROPOSAL)).toBe(expectedLedger);
      expect(mocks.publish).toHaveBeenCalledWith(busEvent, expect.objectContaining({ subject: CONNECTOR_OWNER_DID }));
    },
  );

  it('signs the decision as the owner — decidedBy is the owner, never the operator', async () => {
    await raiseGithub(OWNER_PROPOSAL, CONNECTOR_OWNER_DID);

    await decide(connectorOwnerIdentity(), OWNER_PROPOSAL);

    const decidedPublishes = mocks.publish.mock.calls.filter(([event]) => event === 'operator.approval.decided');
    expect(decidedPublishes.length).toBeGreaterThan(0);
    decidedPublishes.forEach(([, envelope]) => {
      expect(envelope.subject).toBe(CONNECTOR_OWNER_DID);
      expect(envelope.payload.decidedBy).toBe(CONNECTOR_OWNER_DID);
    });
  });
});

describe('connector proposal: the operator sees nothing and is refused (#2723)', () => {
  it.each([
    ['a proposal addressed to its owner at creation', async () => raiseGithub(OWNER_PROPOSAL, CONNECTOR_OWNER_DID)],
    [
      'a legacy proposal still stored under the operator (pre-backlog)',
      seedLegacyOwnerProposal,
    ],
  ])("does not appear in the operator's Inbox: %s", async (_label, arrange) => {
    await arrange();

    const operatorInbox = await inboxOf(operatorIdentity());

    expect(operatorInbox.isOperator).toBe(true);
    expect(proposalIds(operatorInbox)).toEqual([]);
    // …while the owner's Inbox does hold it, with or without the backlog having run.
    expect(proposalIds(await inboxOf(connectorOwnerIdentity()))).toEqual([OWNER_PROPOSAL]);
  });

  it.each([
    ['an addressed-to-owner row', async () => raiseGithub(OWNER_PROPOSAL, CONNECTOR_OWNER_DID)],
    [
      'a legacy row stored under the operator',
      seedLegacyOwnerProposal,
    ],
  ])('refuses the operator confirm AND deny with 403 on %s — nothing is signed or executed', async (_label, arrange) => {
    await arrange();

    const statuses = [(await decide(operatorIdentity(), OWNER_PROPOSAL, 'approve')).status, (await decide(operatorIdentity(), OWNER_PROPOSAL, 'reject')).status];

    expect(statuses).toEqual([403, 403]);
    expect(await ledgerStatus(OWNER_PROPOSAL)).toBe('pending');
    expect((await approvalRow(OWNER_PROPOSAL)).status).toBe('pending');
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("sends no push to the operator for the owner's proposal — the owner is notified instead", async () => {
    await raiseGithub(OWNER_PROPOSAL, CONNECTOR_OWNER_DID);

    expect(mocks.pushWeb).toHaveBeenCalledTimes(1);
    expect(mocks.pushWeb).toHaveBeenCalledWith(CONNECTOR_OWNER_DID, expect.objectContaining({ url: expect.stringContaining(OWNER_PROPOSAL) }));
    expect(mocks.pushWeb).not.toHaveBeenCalledWith(OPERATOR_DID, expect.anything());
  });
});

describe('act-as and delegated agents cannot reach a connector proposal (#2359 × #2723)', () => {
  it.each([
    ['the owner under act-as', { ...connectorOwnerIdentity(), actingAs: GROUP_DID, actingAsRole: 'owner' } as Identity, 'act_as_not_permitted'],
    ['an agent acting for the owner', { ...agentActingForOperatorIdentity(), actingFor: CONNECTOR_OWNER_DID } as Identity, 'act_as_not_permitted'],
  ])('refuses decide from %s with 403 and leaves everything untouched', async (_label, identity, code) => {
    await raiseGithub(OWNER_PROPOSAL, CONNECTOR_OWNER_DID);

    const res = await decide(identity, OWNER_PROPOSAL);

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe(code);
    expect(await ledgerStatus(OWNER_PROPOSAL)).toBe('pending');
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('gives a delegated agent an empty Inbox', async () => {
    await raiseGithub(OWNER_PROPOSAL, CONNECTOR_OWNER_DID);

    const inbox = await inboxOf({ ...agentActingForOperatorIdentity(), actingFor: CONNECTOR_OWNER_DID } as Identity);

    expect(inbox).toEqual({ isOperator: false, approvals: [] });
  });
});

describe('node-level kinds and the operator’s own proposals still go to the operator (#2723)', () => {
  const NODE_LEVEL = [
    ['a gateway restart', GATEWAY_PROPOSAL, 'system-agent', 'system-agent:restart', null],
    ['a gateway config mutation', 'opap_config_1', 'system-agent', 'system-agent:config-mutation', null],
    ['an apps:provision proposal (names its proposer, but is node-level)', 'appprov_1', 'apps', 'apps:provision', { slug: 'x', ownerDid: CONNECTOR_OWNER_DID }],
    ['a vault proposal', 'vprop_1', 'vault', 'vault:mint', { ownerDid: CONNECTOR_OWNER_DID }],
  ] as const;

  it.each(NODE_LEVEL)('%s is addressed to the operator, listed for them, hidden from others, and decidable only by them', async (_label, proposalId, source, kind, detail) => {
    await raise(proposalId, source, kind, detail as Record<string, unknown> | null);

    expect((await approvalRow(proposalId)).operatorDid).toBe(OPERATOR_DID);
    expect(proposalIds(await inboxOf(operatorIdentity()))).toEqual([proposalId]);
    expect(proposalIds(await inboxOf(connectorOwnerIdentity()))).toEqual([]);
    expect((await decide(connectorOwnerIdentity(), proposalId)).status).toBe(403);
    expect((await approvalRow(proposalId)).status).toBe('pending');
    expect((await decide(operatorIdentity(), proposalId)).status).toBe(200);
    expect(mocks.pushWeb).toHaveBeenCalledWith(OPERATOR_DID, expect.anything());
    expect(mocks.pushWeb).not.toHaveBeenCalledWith(CONNECTOR_OWNER_DID, expect.anything());
  });

  it("the operator's own github proposal reaches the operator and only the operator", async () => {
    await raiseGithub(OPERATOR_OWN_PROPOSAL, OPERATOR_DID);

    expect(proposalIds(await inboxOf(operatorIdentity()))).toEqual([OPERATOR_OWN_PROPOSAL]);
    expect(proposalIds(await inboxOf(connectorOwnerIdentity()))).toEqual([]);
    expect((await decide(operatorIdentity(), OPERATOR_OWN_PROPOSAL)).status).toBe(200);
    expect(await ledgerStatus(OPERATOR_OWN_PROPOSAL)).toBe('approved');
  });

  it('each principal sees exactly their own mix when everything is pending at once', async () => {
    await raiseGithub(OWNER_PROPOSAL, CONNECTOR_OWNER_DID);
    await raiseGithub(OPERATOR_OWN_PROPOSAL, OPERATOR_DID);
    await raise(GATEWAY_PROPOSAL, 'system-agent', 'system-agent:restart', null);

    expect(proposalIds(await inboxOf(operatorIdentity())).sort()).toEqual([GATEWAY_PROPOSAL, OPERATOR_OWN_PROPOSAL].sort());
    expect(proposalIds(await inboxOf(connectorOwnerIdentity()))).toEqual([OWNER_PROPOSAL]);
  });
});
