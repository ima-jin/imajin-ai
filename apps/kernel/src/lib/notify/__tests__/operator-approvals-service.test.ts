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
    source: 'source',
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
    source: 'system-agent',
    kind: 'system-agent:restart',
    summary: 'Restart the gateway to load the updated plugin.',
    keysTouched: [],
    detail: null,
    contentHash: null,
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
      source: 'system-agent',
      kind: 'system-agent:restart',
      summary: 'Restart the gateway.',
      keysTouched: ['gateway.version'],
      detail: null,
      contentHash: null,
      notificationId: 'ntf_1',
    });

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: PROPOSAL_ID,
        operatorDid: OPERATOR_DID,
        source: 'system-agent',
        kind: 'system-agent:restart',
        status: 'pending',
      }),
    );
  });

  it('inserts a new pending row with a source-specific detail and contentHash (#2152)', async () => {
    mockSelectLimit.mockResolvedValueOnce([]);
    const detail = { skillName: 'weather-lookup', kind: 'update', scan: 'clean' };

    await recordApprovalRequested({
      proposalId: 'opap_sw_1',
      operatorDid: OPERATOR_DID,
      source: 'skill-workshop',
      kind: 'skill-workshop:update',
      summary: 'Update the weather-lookup skill.',
      keysTouched: [],
      detail,
      contentHash: 'a'.repeat(64),
      notificationId: 'ntf_2',
    });

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'skill-workshop', kind: 'skill-workshop:update', detail, contentHash: 'a'.repeat(64) }),
    );
  });

  it('skips insert when a row already exists (retry-safe)', async () => {
    mockSelectLimit.mockResolvedValueOnce([{ status: 'approved' }]);

    await recordApprovalRequested({
      proposalId: PROPOSAL_ID,
      operatorDid: OPERATOR_DID,
      source: 'system-agent',
      kind: 'system-agent:restart',
      summary: 'Restart the gateway.',
      keysTouched: [],
      detail: null,
      contentHash: null,
      notificationId: 'ntf_1',
    });

    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});

describe('decideOperatorApproval', () => {
  it('approves a pending proposal, signs a decision, and publishes operator.approval.decided with source + kind carried through', async () => {
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
        payload: expect.objectContaining({
          proposalId: PROPOSAL_ID,
          source: 'system-agent',
          kind: 'system-agent:restart',
          decision: 'approve',
          decidedBy: OPERATOR_DID,
        }),
      }),
    );
  });

  it('includes an opaque mode when the caller supplies one, without interpreting it (#2152)', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([row({ status: 'pending' })])
      .mockResolvedValueOnce([row({ status: 'approved' })]);

    await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'approve', mode: 'allow-once' });

    expect(mockPublish).toHaveBeenCalledWith(
      'operator.approval.decided',
      expect.objectContaining({ payload: expect.objectContaining({ mode: 'allow-once' }) }),
    );
  });

  it.each([
    { decision: 'reject' as const, fromStatus: 'pending' as const, toStatus: 'denied' as const },
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

  it('scopes the query by source when one is given (#2152)', async () => {
    const rows = [row({ source: 'skill-workshop', kind: 'skill-workshop:update' })];
    const orderByMock = vi.fn().mockResolvedValue(rows);
    const whereMock = vi.fn(() => ({ orderBy: orderByMock }));
    const { db } = await import('@/src/db');
    vi.mocked(db.select).mockReturnValueOnce({
      from: () => ({ where: whereMock }),
    } as unknown as ReturnType<typeof db.select>);

    const result = await listApprovalsForOperator(OPERATOR_DID, { source: 'skill-workshop' });

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('skill-workshop');
    // and(...) is mocked to collect its args — both the operator and source conditions must be present.
    const { operatorApprovals } = await import('@/src/db');
    expect(whereMock).toHaveBeenCalledWith({
      and: [{ eq: [operatorApprovals.operatorDid, OPERATOR_DID] }, { eq: [operatorApprovals.source, 'skill-workshop'] }],
    });
  });
});
