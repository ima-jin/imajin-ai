/**
 * Unit tests for `executeGithubApproval` (#2293) — the bridge that keeps
 * the connector's write-gate ledger (`github.action_proposals`) and the
 * /jin card (`operator.approvals`'s `outcome`) in sync on every decision
 * (approve/reject/withdrawn) for a `source: 'github'` proposal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OperatorApprovalCard } from '../../notify/operator-approvals-service';

const {
  githubUpdateSetMock,
  operatorUpdateSetMock,
  publishMock,
  getNodeSigningIdentityMock,
  signSyncMock,
} = vi.hoisted(() => ({
  githubUpdateSetMock: vi.fn(),
  operatorUpdateSetMock: vi.fn(),
  publishMock: vi.fn(),
  getNodeSigningIdentityMock: vi.fn(),
  signSyncMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({ publish: publishMock }));

vi.mock('@imajin/auth', () => ({
  canonicalize: (obj: unknown) => JSON.stringify(obj),
  crypto: { signSync: signSyncMock },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

const { GITHUB_TABLE_SENTINEL, OPERATOR_TABLE_SENTINEL } = vi.hoisted(() => ({
  GITHUB_TABLE_SENTINEL: { id: 'id', ownerDid: 'owner_did' },
  OPERATOR_TABLE_SENTINEL: { proposalId: 'proposal_id' },
}));

vi.mock('@/src/db', () => ({
  db: {
    update: (table: unknown) => ({
      set: (values: unknown) => {
        if (table === GITHUB_TABLE_SENTINEL) githubUpdateSetMock(values);
        else operatorUpdateSetMock(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    }),
  },
  githubActionProposals: GITHUB_TABLE_SENTINEL,
  operatorApprovals: OPERATOR_TABLE_SENTINEL,
}));

vi.mock('../../vault/sealing', () => ({
  getNodeSigningIdentity: getNodeSigningIdentityMock,
}));

import { executeGithubApproval, GITHUB_APPEND_KIND, GITHUB_MUTATE_KIND } from '../approvals-execution.js';

const NODE_DID = 'did:imajin:node';
const OWNER_DID = 'did:imajin:owner';

function card(overrides: Partial<OperatorApprovalCard> = {}): OperatorApprovalCard {
  return {
    proposalId: 'proposal_gh1',
    operatorDid: 'did:imajin:operator',
    source: 'github',
    kind: GITHUB_APPEND_KIND,
    summary: 'create_issue org/repo: "Bug"',
    keysTouched: [],
    detail: {
      ownerDid: OWNER_DID,
      agentDid: null,
      scope: 'github:write',
      riskTier: 'append',
      tool: 'github_create_issue',
      target: 'org/repo',
      argsSummary: 'create_issue org/repo: "Bug"',
    },
    contentHash: 'a'.repeat(64),
    status: 'pending',
    decision: null,
    outcome: null,
    appliedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getNodeSigningIdentityMock.mockReturnValue({
    privateKeyHex: 'node-priv',
    senderPubkey: 'node-pub',
    senderDid: NODE_DID,
  });
  signSyncMock.mockReturnValue('deadbeef'.repeat(16));
});

describe('executeGithubApproval — kind/detail validation', () => {
  it('rejects an unrecognized kind', async () => {
    const result = await executeGithubApproval(card({ kind: 'github:something-else' }), 'approve', undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unrecognized github proposal kind/);
    expect(githubUpdateSetMock).not.toHaveBeenCalled();
  });

  it('rejects a proposal missing required detail fields', async () => {
    const result = await executeGithubApproval(card({ detail: { ownerDid: OWNER_DID } }), 'approve', undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing required detail fields/);
    expect(githubUpdateSetMock).not.toHaveBeenCalled();
  });
});

describe('executeGithubApproval — approve', () => {
  it('defaults to a single-call approval (approvedUntil null) when mode is omitted', async () => {
    const result = await executeGithubApproval(card(), 'approve', undefined);

    expect(result.ok).toBe(true);
    expect(githubUpdateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'approved',
      approvedUntil: null,
      ownerAuthorization: expect.objectContaining({ signature: expect.any(String), senderPubkey: 'node-pub' }),
    }));
    expect(operatorUpdateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({ approvedUntil: null }),
    }));
    expect(publishMock).toHaveBeenCalledWith('action.approved', expect.objectContaining({
      scope: 'github',
      payload: expect.objectContaining({ proposalId: 'proposal_gh1', ownerDid: OWNER_DID, approvedUntil: null }),
    }));
  });

  it('computes a ~5 minute window for mode=5m', async () => {
    const before = Date.now();
    const result = await executeGithubApproval(card(), 'approve', '5m');
    const after = Date.now();

    expect(result.ok).toBe(true);
    const setCall = githubUpdateSetMock.mock.calls[0][0] as { approvedUntil: Date };
    expect(setCall.approvedUntil).toBeInstanceOf(Date);
    const deltaMs = setCall.approvedUntil.getTime() - before;
    expect(deltaMs).toBeGreaterThanOrEqual(5 * 60 * 1000 - 50);
    expect(deltaMs).toBeLessThanOrEqual(5 * 60 * 1000 + (after - before) + 50);
  });

  it('computes a ~24 hour window for mode=24h', async () => {
    const before = Date.now();
    const result = await executeGithubApproval(card({ kind: GITHUB_MUTATE_KIND }), 'approve', '24h');

    expect(result.ok).toBe(true);
    const setCall = githubUpdateSetMock.mock.calls[0][0] as { approvedUntil: Date };
    const deltaMs = setCall.approvedUntil.getTime() - before;
    expect(deltaMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(deltaMs).toBeLessThan(25 * 60 * 60 * 1000);
  });

  it('rejects an unknown TTL mode without mutating either table', async () => {
    const result = await executeGithubApproval(card(), 'approve', 'forever');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mode must be one of/);
    expect(githubUpdateSetMock).not.toHaveBeenCalled();
    expect(operatorUpdateSetMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe('executeGithubApproval — reject', () => {
  it('marks the ledger row denied and publishes action.denied, without touching the operator.approvals outcome', async () => {
    const result = await executeGithubApproval(card(), 'reject', undefined);

    expect(result.ok).toBe(true);
    expect(githubUpdateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'denied' }));
    expect(operatorUpdateSetMock).not.toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledWith('action.denied', expect.objectContaining({
      scope: 'github',
      payload: expect.objectContaining({ proposalId: 'proposal_gh1', ownerDid: OWNER_DID }),
    }));
  });
});

describe('executeGithubApproval — withdrawn', () => {
  it('marks the ledger row expired (no withdrawn state exists on the ledger) and does not publish', async () => {
    const result = await executeGithubApproval(card({ status: 'approved' }), 'withdrawn', undefined);

    expect(result.ok).toBe(true);
    expect(githubUpdateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    expect(operatorUpdateSetMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });
});
