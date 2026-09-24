/**
 * Tests for the operator-approvals lifecycle service (#2059): the proposal
 * state machine (pending -> approved|denied; approved -> withdrawn|applied),
 * the signed decision attestation, and the `operator.approval.decided`
 * bus publish.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AGENT_DID, OPERATOR_DID, PROPOSAL_ID, pendingApprovalCard } from './operator-approvals-test-helpers';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockSelectLimit,
  mockInsertValues,
  mockUpdateWhere,
  mockPublish,
  mockSignSync,
  mockVerifyOperatorCountersignature,
  mockIsOperatorCountersignRequired,
  mockEffectiveContentHash,
} = vi.hoisted(() => ({
  mockSelectLimit: vi.fn(),
  mockInsertValues: vi.fn().mockResolvedValue(undefined),
  mockUpdateWhere: vi.fn().mockResolvedValue(undefined),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockSignSync: vi.fn(() => 'sig_fake'),
  mockVerifyOperatorCountersignature: vi.fn(),
  // #2082: default OFF, same as production default — individual tests flip
  // this on to exercise the "kernel-forged decision" rejection path.
  mockIsOperatorCountersignRequired: vi.fn(() => false),
  // #2294: delegates to the REAL effectiveContentHash by default (wired up
  // in the `../operator-approvals` mock factory below, once the real module
  // is available) — only the "fail-closed" test overrides this to throw.
  mockEffectiveContentHash: vi.fn(),
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

// Real `canonicalize` (not a trivial JSON.stringify stand-in) so the hash
// this test file's `pendingApprovalCard` fixture computes and the hash
// `effectiveContentHash`/`computeApprovalContentHash` (loaded for real via
// the `../operator-approvals` importOriginal mock below) compute can never
// silently diverge.
vi.mock('@imajin/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@imajin/auth')>();
  return {
    canonicalize: actual.canonicalize,
    crypto: { signSync: mockSignSync },
    SIGNED_MESSAGE_MAX_AGE: 5 * 60 * 1000,
    FUTURE_TOLERANCE: 30 * 1000,
  };
});

vi.mock('@imajin/bus', () => ({ publish: mockPublish }));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({ privateKeyHex: 'a'.repeat(64), senderPubkey: 'b'.repeat(64) }),
}));

vi.mock('nanoid', () => ({ nanoid: () => 'fixedid1234' }));

// operator-approvals.ts imports node-identity.ts, which calls getClient() at
// module scope (requires DATABASE_URL) — stub it so importOriginal() below
// can load the real (pure) effectiveContentHash/computeApprovalContentHash
// without a DB, exactly like the route tests already do.
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));

vi.mock('../operator-countersign', () => ({ verifyOperatorCountersignature: mockVerifyOperatorCountersignature }));

vi.mock('../operator-approvals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../operator-approvals')>();
  mockEffectiveContentHash.mockImplementation(actual.effectiveContentHash);
  return {
    ...actual,
    isOperatorCountersignRequired: mockIsOperatorCountersignRequired,
    effectiveContentHash: mockEffectiveContentHash,
  };
});

// ─── Subject ─────────────────────────────────────────────────────────────────

import {
  recordApprovalRequested,
  decideOperatorApproval,
  markApplied,
  attachApprovalOutcome,
  listApprovalsForOperator,
} from '../operator-approvals-service';
import { EXEC_COMMAND_KIND, EXEC_COMMAND_SOURCE } from '../exec-command-approvals';
import { computeApprovalContentHash, validateApprovalRequestedPayload } from '../operator-approvals';

function execCommandDetail(overrides: Record<string, unknown> = {}) {
  return {
    command: 'systemctl restart openclaw-gateway',
    host: 'gateway-01',
    cwd: '/opt/openclaw',
    agentId: 'agent_123',
    sessionKey: 'session_abc',
    requestedBy: 'did:imajin:jin-agent',
    approvalId: 'oc_approval_1',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function execCommandRow(overrides: Record<string, unknown> = {}) {
  return row({
    source: EXEC_COMMAND_SOURCE,
    kind: EXEC_COMMAND_KIND,
    detail: execCommandDetail(),
    ...overrides,
  });
}

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
    // #2337: null by default (no requesting-agent DID captured, e.g. a
    // legacy row) so every pre-existing test here keeps exercising
    // operator-only delivery unchanged — tests that care about the
    // dual-recipient behavior override this explicitly.
    signerDid: null,
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
      signerDid: null,
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

  it('records the requesting agent\'s signerDid when the source adapter supplied one (#2337)', async () => {
    mockSelectLimit.mockResolvedValueOnce([]);

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
      signerDid: AGENT_DID,
    });

    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ signerDid: AGENT_DID }));
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
      signerDid: null,
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
      signerDid: null,
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

  // #2337: `operator.approval.decided` was only ever addressed to the
  // operator, so the agent that raised the proposal (`row.signerDid`)
  // never received the decision. These pin the fix: the SAME signed
  // payload — contentHash and operatorSignature included, byte-for-byte —
  // is published once per distinct recipient.
  describe('delivery to both the requesting agent and the operator (#2337)', () => {
    it('publishes operator.approval.decided to both the requesting agent DID and the operator DID', async () => {
      mockSelectLimit
        .mockResolvedValueOnce([row({ status: 'pending', signerDid: AGENT_DID })])
        .mockResolvedValueOnce([row({ status: 'approved', signerDid: AGENT_DID })]);

      const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'approve' });

      expect(result.ok).toBe(true);
      expect(mockPublish).toHaveBeenCalledTimes(2);
      const subjects = mockPublish.mock.calls.map((call) => (call[1] as { subject: string }).subject).sort();
      expect(subjects).toEqual([AGENT_DID, OPERATOR_DID].sort());
      // Both publishes must carry the exact same signed payload — #2337
      // must never fork the wire shape to address a second recipient.
      const payloads = mockPublish.mock.calls.map((call) => (call[1] as { payload: unknown }).payload);
      expect(payloads[0]).toEqual(payloads[1]);
      expect(mockPublish).toHaveBeenCalledWith(
        'operator.approval.decided',
        expect.objectContaining({ issuer: OPERATOR_DID, subject: AGENT_DID, scope: 'operator' }),
      );
    });

    it('preserves contentHash and operatorSignature identically across both publishes', async () => {
      const OPERATOR_SIG = { keyId: 'a'.repeat(64), alg: 'ed25519' as const, sig: 'b'.repeat(128) };
      const decidedAt = new Date().toISOString();
      mockVerifyOperatorCountersignature.mockResolvedValueOnce({ ok: true });
      mockSelectLimit
        .mockResolvedValueOnce([row({ status: 'pending', signerDid: AGENT_DID })])
        .mockResolvedValueOnce([row({ status: 'approved', signerDid: AGENT_DID })]);

      const result = await decideOperatorApproval({
        proposalId: PROPOSAL_ID,
        operatorDid: OPERATOR_DID,
        decision: 'approve',
        operatorSignature: OPERATOR_SIG,
        decidedAt,
      });

      expect(result.ok).toBe(true);
      expect(mockPublish).toHaveBeenCalledTimes(2);
      for (const call of mockPublish.mock.calls) {
        expect(call[1]).toEqual(
          expect.objectContaining({
            payload: expect.objectContaining({ operatorSignature: OPERATOR_SIG, decidedAt }),
          }),
        );
      }
    });

    it('publishes only once when signerDid equals the operator DID (no duplicate delivery)', async () => {
      mockSelectLimit
        .mockResolvedValueOnce([row({ status: 'pending', signerDid: OPERATOR_DID })])
        .mockResolvedValueOnce([row({ status: 'approved', signerDid: OPERATOR_DID })]);

      const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'approve' });

      expect(result.ok).toBe(true);
      expect(mockPublish).toHaveBeenCalledOnce();
    });

    it('publishes only to the operator when no signerDid was captured (legacy row)', async () => {
      mockSelectLimit
        .mockResolvedValueOnce([row({ status: 'pending', signerDid: null })])
        .mockResolvedValueOnce([row({ status: 'approved', signerDid: null })]);

      const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'approve' });

      expect(result.ok).toBe(true);
      expect(mockPublish).toHaveBeenCalledOnce();
      expect(mockPublish).toHaveBeenCalledWith(
        'operator.approval.decided',
        expect.objectContaining({ subject: OPERATOR_DID }),
      );
    });

    it("one recipient's publish failure never suppresses the other's, nor fails the decision (non-fatal per-recipient)", async () => {
      mockPublish.mockRejectedValueOnce(new Error('bus unavailable for first recipient'));
      mockSelectLimit
        .mockResolvedValueOnce([row({ status: 'pending', signerDid: AGENT_DID })])
        .mockResolvedValueOnce([row({ status: 'approved', signerDid: AGENT_DID })]);

      const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'approve' });

      expect(result.ok).toBe(true);
      // Both recipients were attempted even though the first rejected.
      expect(mockPublish).toHaveBeenCalledTimes(2);
    });
  });

  // #2221: the allow-once/deny-only gate and expiry refusal are exec.command
  // only — every other kind's decisions are unaffected by this block.
  describe('exec.command gate (#2221)', () => {
    it('approves an exec.command proposal with mode allow-once', async () => {
      mockSelectLimit
        .mockResolvedValueOnce([execCommandRow({ status: 'pending' })])
        .mockResolvedValueOnce([execCommandRow({ status: 'approved' })]);

      const result = await decideOperatorApproval({
        proposalId: PROPOSAL_ID,
        operatorDid: OPERATOR_DID,
        decision: 'approve',
        mode: 'allow-once',
      });

      expect(result.ok).toBe(true);
    });

    it('rejects (400) mode allow-always before any state mutation or signature — the exact loophole this gate closes', async () => {
      mockSelectLimit.mockResolvedValueOnce([execCommandRow({ status: 'pending' })]);

      const result = await decideOperatorApproval({
        proposalId: PROPOSAL_ID,
        operatorDid: OPERATOR_DID,
        decision: 'approve',
        mode: 'allow-always',
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/allow-always/);
      expect(mockSignSync).not.toHaveBeenCalled();
      expect(mockUpdateWhere).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('rejects (400) an arbitrary mode value paired with reject', async () => {
      mockSelectLimit.mockResolvedValueOnce([execCommandRow({ status: 'pending' })]);

      const result = await decideOperatorApproval({
        proposalId: PROPOSAL_ID,
        operatorDid: OPERATOR_DID,
        decision: 'reject',
        mode: 'allow-once',
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.status).toBe(400);
    });

    it('rejects (409) a decision on an expired approval, before any state mutation or signature', async () => {
      mockSelectLimit.mockResolvedValueOnce([
        execCommandRow({ status: 'pending', detail: execCommandDetail({ expiresAt: '2000-01-01T00:00:00.000Z' }) }),
      ]);

      const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'approve' });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/expired/);
      expect(mockSignSync).not.toHaveBeenCalled();
      expect(mockUpdateWhere).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('rejects (409) an expired approval even for a deny decision', async () => {
      mockSelectLimit.mockResolvedValueOnce([
        execCommandRow({ status: 'pending', detail: execCommandDetail({ expiresAt: '2000-01-01T00:00:00.000Z' }) }),
      ]);

      const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'reject' });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.status).toBe(409);
    });

    it('leaves non-exec.command kinds unaffected by the mode gate (an arbitrary mode is still just opaque, #2152)', async () => {
      mockSelectLimit
        .mockResolvedValueOnce([row({ status: 'pending' })])
        .mockResolvedValueOnce([row({ status: 'approved' })]);

      const result = await decideOperatorApproval({
        proposalId: PROPOSAL_ID,
        operatorDid: OPERATOR_DID,
        decision: 'approve',
        mode: 'allow-always',
      });

      expect(result.ok).toBe(true);
    });
  });

  // #2082: operator countersignature — the "kernel-forged decision" guard,
  // verification wiring, and the withdraw path all funnel through this same
  // function, so they're covered here rather than only at the route layer.
  describe('operator countersignature (#2082)', () => {
    const OPERATOR_SIG = { keyId: 'a'.repeat(64), alg: 'ed25519' as const, sig: 'b'.repeat(128) };
    // Must be within the mocked SIGNED_MESSAGE_MAX_AGE/FUTURE_TOLERANCE
    // window of the real clock at test-run time — computed fresh per call
    // rather than a fixed literal, which would eventually age out.
    const recentDecidedAt = () => new Date().toISOString();

    it('rejects (400) a decision with no operatorSignature once the per-node flag is on — before any state mutation', async () => {
      mockIsOperatorCountersignRequired.mockReturnValueOnce(true);
      mockSelectLimit.mockResolvedValueOnce([row({ status: 'pending' })]);

      const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'approve' });

      expect(result).toEqual({ ok: false, error: 'Operator countersignature is required on this node', status: 400 });
      expect(mockVerifyOperatorCountersignature).not.toHaveBeenCalled();
      expect(mockSignSync).not.toHaveBeenCalled();
      expect(mockUpdateWhere).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('accepts a decision with no operatorSignature while the flag is off (unchanged v1 behavior)', async () => {
      mockSelectLimit
        .mockResolvedValueOnce([row({ status: 'pending' })])
        .mockResolvedValueOnce([row({ status: 'approved' })]);

      const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'approve' });

      expect(result.ok).toBe(true);
      expect(mockVerifyOperatorCountersignature).not.toHaveBeenCalled();
    });

    it('verifies a supplied operatorSignature even while the flag is off, and rejects (400) on failure', async () => {
      mockVerifyOperatorCountersignature.mockResolvedValueOnce({ ok: false, error: 'Invalid operator signature' });
      mockSelectLimit.mockResolvedValueOnce([row({ status: 'pending' })]);

      const result = await decideOperatorApproval({
        proposalId: PROPOSAL_ID,
        operatorDid: OPERATOR_DID,
        decision: 'approve',
        operatorSignature: OPERATOR_SIG,
        decidedAt: recentDecidedAt(),
      });

      expect(result).toEqual({ ok: false, error: 'Invalid operator signature', status: 400 });
      expect(mockSignSync).not.toHaveBeenCalled();
      expect(mockUpdateWhere).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('rejects (400) a mismatched/unknown/revoked key surfaced by verifyOperatorCountersignature', async () => {
      mockVerifyOperatorCountersignature.mockResolvedValueOnce({
        ok: false,
        error: "operatorSignature.keyId does not match the operator DID's current registered key (unknown or revoked key)",
      });
      mockSelectLimit.mockResolvedValueOnce([row({ status: 'pending' })]);

      const result = await decideOperatorApproval({
        proposalId: PROPOSAL_ID,
        operatorDid: OPERATOR_DID,
        decision: 'approve',
        operatorSignature: OPERATOR_SIG,
        decidedAt: recentDecidedAt(),
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/revoked key/);
    });

    it('rejects (400) when operatorSignature is supplied without decidedAt', async () => {
      mockSelectLimit.mockResolvedValueOnce([row({ status: 'pending' })]);

      const result = await decideOperatorApproval({
        proposalId: PROPOSAL_ID,
        operatorDid: OPERATOR_DID,
        decision: 'approve',
        operatorSignature: OPERATOR_SIG,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.status).toBe(400);
      expect(mockVerifyOperatorCountersignature).not.toHaveBeenCalled();
    });

    it('rejects (400) when decidedAt is outside the accepted clock-skew window', async () => {
      mockSelectLimit.mockResolvedValueOnce([row({ status: 'pending' })]);

      const result = await decideOperatorApproval({
        proposalId: PROPOSAL_ID,
        operatorDid: OPERATOR_DID,
        decision: 'approve',
        operatorSignature: OPERATOR_SIG,
        decidedAt: '2000-01-01T00:00:00.000Z', // far outside SIGNED_MESSAGE_MAX_AGE
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.status).toBe(400);
      expect(mockVerifyOperatorCountersignature).not.toHaveBeenCalled();
    });

    // Happy path for both approve and withdrawn — parameterized (rather than
    // two near-identical bodies) to keep this under SonarCloud's duplicated-
    // lines guard on new code.
    it.each([
      { decision: 'approve' as const, fromStatus: 'pending' as const, toStatus: 'approved' as const },
      { decision: 'withdrawn' as const, fromStatus: 'approved' as const, toStatus: 'withdrawn' as const },
    ])(
      'verifies, persists, and publishes a valid operatorSignature for decision=$decision using the client-claimed decidedAt',
      async ({ decision, fromStatus, toStatus }) => {
        const decidedAt = recentDecidedAt();
        mockVerifyOperatorCountersignature.mockResolvedValueOnce({ ok: true });
        mockSelectLimit
          .mockResolvedValueOnce([row({ status: fromStatus })])
          .mockResolvedValueOnce([row({ status: toStatus })]);

        const result = await decideOperatorApproval({
          proposalId: PROPOSAL_ID,
          operatorDid: OPERATOR_DID,
          decision,
          operatorSignature: OPERATOR_SIG,
          decidedAt,
        });

        expect(result.ok).toBe(true);
        expect(mockVerifyOperatorCountersignature).toHaveBeenCalledWith(
          OPERATOR_DID,
          expect.objectContaining({ decision, decidedAt }),
          OPERATOR_SIG,
        );
        expect(mockPublish).toHaveBeenCalledWith(
          'operator.approval.decided',
          expect.objectContaining({
            payload: expect.objectContaining({ decidedAt, operatorSignature: OPERATOR_SIG }),
          }),
        );
      },
    );

    it('rejects (400) a kernel-forged withdrawal with no operatorSignature once the flag is on', async () => {
      mockIsOperatorCountersignRequired.mockReturnValueOnce(true);
      mockSelectLimit.mockResolvedValueOnce([row({ status: 'approved' })]);

      const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'withdrawn' });

      expect(result).toEqual({ ok: false, error: 'Operator countersignature is required on this node', status: 400 });
      expect(mockUpdateWhere).not.toHaveBeenCalled();
    });
  });

  // #2294: `operator.approval.decided` must carry `contentHash` so a source
  // adapter's #2084 echo check (e.g. `ima-jin/openclaw-imajin-plugin`'s
  // gateway-approvals bridge, `handleKernelDecision`'s "check 1") can ever
  // pass in production.
  describe('contentHash on the decided payload (#2294)', () => {
    it('includes a sha256:-prefixed contentHash matching the legacy bare-kind row\'s recomputed hash', async () => {
      const legacyRow = row({ status: 'pending', source: 'system-agent', kind: 'system-agent:restart', contentHash: null });
      mockSelectLimit.mockResolvedValueOnce([legacyRow]).mockResolvedValueOnce([{ ...legacyRow, status: 'approved' }]);

      const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'approve' });

      expect(result.ok).toBe(true);
      const expectedHash = computeApprovalContentHash({
        proposalId: legacyRow.proposalId,
        source: legacyRow.source,
        kind: legacyRow.kind,
        summary: legacyRow.summary,
        keysTouched: legacyRow.keysTouched,
        detail: legacyRow.detail,
      });
      expect(mockPublish).toHaveBeenCalledWith(
        'operator.approval.decided',
        expect.objectContaining({ payload: expect.objectContaining({ contentHash: `sha256:${expectedHash}` }) }),
      );
    });

    it('echoes back exactly the contentHash the proposal was staged with (open-vocabulary row, #2152)', async () => {
      const detail = { skillName: 'weather-lookup', kind: 'update', scan: 'clean' };
      const stagedHash = computeApprovalContentHash({
        proposalId: PROPOSAL_ID,
        source: 'skill-workshop',
        kind: 'skill-workshop:update',
        summary: 'Update the weather-lookup skill.',
        keysTouched: [],
        detail,
      });
      const openVocabRow = row({
        status: 'pending',
        source: 'skill-workshop',
        kind: 'skill-workshop:update',
        summary: 'Update the weather-lookup skill.',
        detail,
        contentHash: stagedHash,
      });
      mockSelectLimit.mockResolvedValueOnce([openVocabRow]).mockResolvedValueOnce([{ ...openVocabRow, status: 'approved' }]);

      const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'approve' });

      expect(result.ok).toBe(true);
      expect(mockPublish).toHaveBeenCalledWith(
        'operator.approval.decided',
        expect.objectContaining({ payload: expect.objectContaining({ contentHash: `sha256:${stagedHash}` }) }),
      );
    });

    it('round-trips against a fixture matching the openclaw-imajin-plugin #45 bridge\'s own digest (request -> ingest -> decide -> echo)', async () => {
      // Mirrors `buildDigestFields`/`computeContentHash` in the plugin's
      // `gateway-approvals-bridge.ts` exactly: six canonical fields,
      // `keysTouched` always `[]`, the source's native revision pin folded
      // into `detail.sourceRevision`, "sha256:" always prefixed on the wire.
      const digestFields = {
        proposalId: 'system-agent:abc123',
        source: 'system-agent',
        kind: 'system-agent:restart',
        summary: 'Restart the gateway to load the updated plugin',
        keysTouched: [] as string[],
        detail: { sourceRevision: 'a'.repeat(64) },
      };
      const bridgeComputedContentHash = `sha256:${computeApprovalContentHash(digestFields)}`;

      // Ingest: the kernel independently recomputes and normalizes (strips
      // the "sha256:" prefix) exactly like `POST /notify/api/send` would.
      const ingestResult = validateApprovalRequestedPayload({
        proposalId: digestFields.proposalId,
        source: digestFields.source,
        kind: digestFields.kind,
        summary: digestFields.summary,
        keysTouched: digestFields.keysTouched,
        detail: digestFields.detail,
        contentHash: bridgeComputedContentHash,
      });
      expect(ingestResult.ok).toBe(true);

      const stagedRow = row({
        proposalId: digestFields.proposalId,
        status: 'pending',
        source: ingestResult.source,
        kind: ingestResult.kind,
        summary: digestFields.summary,
        keysTouched: digestFields.keysTouched,
        detail: ingestResult.detail,
        contentHash: ingestResult.contentHash,
      });
      mockSelectLimit.mockResolvedValueOnce([stagedRow]).mockResolvedValueOnce([{ ...stagedRow, status: 'approved' }]);

      const result = await decideOperatorApproval({
        proposalId: digestFields.proposalId,
        operatorDid: OPERATOR_DID,
        decision: 'approve',
      });

      expect(result.ok).toBe(true);
      // The exact value `handleKernelDecision`'s #2084 "check 1"
      // (`payload.contentHash !== tracked.contentHash`) compares against —
      // byte-for-byte identical to what the bridge itself computed and
      // published on the original request.
      expect(mockPublish).toHaveBeenCalledWith(
        'operator.approval.decided',
        expect.objectContaining({ payload: expect.objectContaining({ contentHash: bridgeComputedContentHash }) }),
      );
    });

    it('fails closed (500), before any state mutation or publish, when contentHash cannot be computed', async () => {
      mockEffectiveContentHash.mockImplementationOnce(() => {
        throw new Error('canonicalize blew up');
      });
      mockSelectLimit.mockResolvedValueOnce([row({ status: 'pending' })]);

      const result = await decideOperatorApproval({ proposalId: PROPOSAL_ID, operatorDid: OPERATOR_DID, decision: 'approve' });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.status).toBe(500);
      expect(mockSignSync).not.toHaveBeenCalled();
      expect(mockUpdateWhere).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
    });
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

describe('attachApprovalOutcome (#2221)', () => {
  const OUTCOME = { exitCode: 0, durationMs: 1234, outputHash: 'a'.repeat(64) };

  it('attaches an outcome to an exec.command approval', async () => {
    mockSelectLimit.mockResolvedValueOnce([execCommandRow({ status: 'approved' })]);

    const result = await attachApprovalOutcome(PROPOSAL_ID, OUTCOME);

    expect(result).toEqual({ ok: true });
    expect(mockUpdateWhere).toHaveBeenCalledOnce();
  });

  it('rejects (with an error) an outcome for a non-exec.command kind', async () => {
    mockSelectLimit.mockResolvedValueOnce([row({ status: 'approved' })]);

    const result = await attachApprovalOutcome(PROPOSAL_ID, OUTCOME);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exec.command/);
    expect(mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('rejects (with an error) an unknown proposal', async () => {
    mockSelectLimit.mockResolvedValueOnce([]);

    const result = await attachApprovalOutcome(PROPOSAL_ID, OUTCOME);

    expect(result).toEqual({ ok: false, error: 'Proposal not found' });
  });

  it('overwrites a previously-attached outcome (idempotent re-post)', async () => {
    mockSelectLimit.mockResolvedValueOnce([execCommandRow({ status: 'approved', outcome: { exitCode: 1, durationMs: 1, outputHash: 'b'.repeat(64) } })]);

    const result = await attachApprovalOutcome(PROPOSAL_ID, OUTCOME);

    expect(result).toEqual({ ok: true });
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
