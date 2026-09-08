/**
 * Tests for the operator-approvals lifecycle service (#2059): the proposal
 * state machine (pending -> approved|denied; approved -> withdrawn|applied),
 * the signed decision attestation, and the `operator.approval.decided`
 * bus publish.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OPERATOR_DID, PROPOSAL_ID, pendingApprovalCard } from './operator-approvals-test-helpers';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockSelectLimit,
  mockInsertValues,
  mockUpdateWhere,
  mockPublish,
  mockSignSync,
} = vi.hoisted(() => ({
  mockSelectLimit: vi.fn(),
  mockInsertValues: vi.fn().mockResolvedValue(undefined),
  mockUpdateWhere: vi.fn().mockResolvedValue(undefined),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockSignSync: vi.fn(() => 'sig_fake'),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: mockSelectLimit }) }) })),
    insert: vi.fn(() => ({ values: mockInsertValues })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: mockUpdateWhere })) })),
  },
  operatorApprovals: {
    proposalId: 'proposal_id',
    operatorDid: 'operator_did',
    status: 'status',
    createdAt: 'created_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  desc: (...args: unknown[]) => ({ desc: args }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/auth', () => ({
  canonicalize: (x: unknown) => JSON.stringify(x),
  crypto: { signSync: mockSignSync },
}));

vi.mock('@imajin/bus', () => ({ publish: mockPublish }));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({ privateKeyHex: 'a'.repeat(64), senderPubkey: 'b'.repeat(64) }),
}));

vi.mock('nanoid', () => ({ nanoid: () => 'fixedid1234' }));

// ─── Subject ─────────────────────────────────────────────────────────────────

import {
  recordApprovalRequested,
  decideOperatorApproval,
  markApplied,
  listApprovalsForOperator,
} from '../operator-approvals-service';

function row(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: PROPOSAL_ID,
    operatorDid: OPERATOR_DID,
    kind: 'restart',
    summary: 'Restart the gateway to load the updated plugin.',
    keysTouched: [],
    notificationId: 'ntf_1',
    status: 'pending',
    decision: null,
    appliedAt: null,
    createdAt: new Date('2026-09-08T00:00:00.000Z'),
    updatedAt: new Date('2026-09-08T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectLimit.mockResolvedValue([]);
  mockInsertValues.mockResolvedValue(undefined);
  mockUpdateWhere.mockResolvedValue(undefined);
  mockPublish.mockResolvedValue(undefined);
});

describe('recordApprovalRequested', () => {
  it('inserts a new pending row', async () => {
    mockSelectLimit.mockResolvedValueOnce([]); // no existing row

    await recordApprovalRequested({
      proposalId: PROPOSAL_ID,
      operatorDid: OPERATOR_DID,
      kind: 'restart',
      summary: 'Restart the gateway.',
      keysTouched: ['gateway.version'],
      notificationId: 'ntf_1',
    });

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, status: 'pending' }),
    );
  });

  it('skips insert when a row already exists (retry-safe)', async () => {
    mockSelectLimit.mockResolvedValueOnce([{ status: 'approved' }]);

    await recordApprovalRequested({
      proposalId: PROPOSAL_ID,
      operatorDid: OPERATOR_DID,
      kind: 'restart',
      summary: 'Restart the gateway.',
      keysTouched: [],
      notificationId: 'ntf_1',
    });

    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});

describe('decideOperatorApproval', () => {
  it('approves a pending proposal, signs a decision, and publishes operator.approval.decided', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([row({ status: 'pending' })]) // loadApproval before decide
      .mockResolvedValueOnce([row({ status: 'approved' })]); // loadApproval after update

    const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'approve' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.card.status).toBe('approved');
    expect(mockSignSync).toHaveBeenCalledOnce();
    expect(mockPublish).toHaveBeenCalledWith(
      'operator.approval.decided',
      expect.objectContaining({
        issuer: OPERATOR_DID,
        subject: OPERATOR_DID,
        payload: expect.objectContaining({ proposalId: PROPOSAL_ID, decision: 'approve', decidedBy: OPERATOR_DID }),
      }),
    );
  });

  it.each([
    { decision: 'deny' as const, fromStatus: 'pending' as const, toStatus: 'denied' as const },
    { decision: 'withdrawn' as const, fromStatus: 'approved' as const, toStatus: 'withdrawn' as const },
  ])('transitions $fromStatus -> $toStatus for decision=$decision', async ({ decision, fromStatus, toStatus }) => {
    mockSelectLimit
      .mockResolvedValueOnce([row({ status: fromStatus })])
      .mockResolvedValueOnce([row({ status: toStatus })]);

    const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.card.status).toBe(toStatus);
  });

  it('rejects deciding a proposal addressed to a different operator DID (404, not a leak)', async () => {
    mockSelectLimit.mockResolvedValueOnce([row({ operatorDid: 'did:imajin:someone-else' })]);

    const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'approve' });

    expect(result).toEqual({ ok: false, error: 'Proposal not found', status: 404 });
    expect(mockSignSync).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown proposal', async () => {
    mockSelectLimit.mockResolvedValueOnce([]);

    const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'approve' });

    expect(result).toEqual({ ok: false, error: 'Proposal not found', status: 404 });
  });

  it.each([
    { label: 'approving an already-decided proposal', currentStatus: 'denied' as const, decision: 'approve' as const },
    { label: 'withdrawing a proposal that was never approved (still pending)', currentStatus: 'pending' as const, decision: 'withdrawn' as const },
    // #2059 acceptance (f): withdrawal is only legal while pending-apply.
    { label: 'withdrawing a proposal that has already been applied', currentStatus: 'applied' as const, decision: 'withdrawn' as const },
  ])('rejects (409) $label', async ({ currentStatus, decision }) => {
    mockSelectLimit.mockResolvedValueOnce([row({ status: currentStatus })]);

    const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure result');
    expect(result.status).toBe(409);
    expect(mockSignSync).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('still records the decision when the publish fails (non-fatal)', async () => {
    mockPublish.mockRejectedValueOnce(new Error('bus unavailable'));
    mockSelectLimit
      .mockResolvedValueOnce([row({ status: 'pending' })])
      .mockResolvedValueOnce([row({ status: 'approved' })]);

    const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'approve' });

    expect(result.ok).toBe(true);
  });
});

describe('markApplied', () => {
  it('transitions an approved proposal to applied', async () => {
    mockSelectLimit.mockResolvedValueOnce([row({ status: 'approved' })]);
    expect(await markApplied(PROPOSAL_ID)).toEqual({ ok: true });
    expect(mockUpdateWhere).toHaveBeenCalledOnce();
  });

  it('is idempotent for an already-applied proposal', async () => {
    mockSelectLimit.mockResolvedValueOnce([row({ status: 'applied' })]);
    expect(await markApplied(PROPOSAL_ID)).toEqual({ ok: true });
    expect(mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('is a no-op for a proposal not currently approved', async () => {
    mockSelectLimit.mockResolvedValueOnce([row({ status: 'denied' })]);
    expect(await markApplied(PROPOSAL_ID)).toEqual({ ok: false });
  });

  it('is a no-op for an unknown proposal', async () => {
    mockSelectLimit.mockResolvedValueOnce([]);
    expect(await markApplied(PROPOSAL_ID)).toEqual({ ok: false });
  });
});

describe('listApprovalsForOperator', () => {
  it('maps rows to cards, newest first per the query ordering', async () => {
    const rows = [row({ status: 'pending' }), row({ proposalId: 'opap_2', status: 'approved' })];
    // The select().from().where().orderBy() chain used by listApprovalsForOperator
    // resolves directly (no .limit()), so this test drives its own chain mock
    // rather than reusing mockSelectLimit (which backs the .limit() shape).
    const orderByMock = vi.fn().mockResolvedValue(rows);
    const { db } = await import('@/src/db');
    vi.mocked(db.select).mockReturnValueOnce({
      from: () => ({ where: () => ({ orderBy: orderByMock }) }),
    } as unknown as ReturnType<typeof db.select>);

    const result = await listApprovalsForOperator(OPERATOR_DID);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject(pendingApprovalCard({ createdAt: rows[0].createdAt.toISOString(), updatedAt: rows[0].updatedAt.toISOString() }));
  });
});
