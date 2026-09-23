/**
 * Tests for the DecisionCard emitter (#2315): the operator.approvals row
 * shape it writes (following the #2247/#2252 `recordApprovalRequested`
 * pattern) and the prose + `ev:` render it returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DecisionCardInput } from '../schema';

const { mockRecordApprovalRequested, mockGetOperatorDid } = vi.hoisted(() => ({
  mockRecordApprovalRequested: vi.fn().mockResolvedValue(undefined),
  mockGetOperatorDid: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../notify/operator-approvals-service', () => ({
  recordApprovalRequested: mockRecordApprovalRequested,
}));

vi.mock('../../notify/operator-approvals', () => ({
  getOperatorDid: mockGetOperatorDid,
}));

import { emitDecisionCard, renderDecisionCardProse, renderDecisionCardEvidenceLine, DECISION_APPROVAL_SOURCE, DECISION_APPROVAL_KIND } from '../emit';
import { createDecisionCard } from '../schema';

const OPERATOR_DID = 'did:imajin:operator';

function input(overrides: Partial<DecisionCardInput> = {}): DecisionCardInput {
  return {
    id: 'dcard_fixed',
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'review',
    subject: { kind: 'pr', ref: '#2315', url: 'https://github.com/ima-jin/imajin-ai/pull/2315' },
    question: 'Merge #2315 now?',
    options: [
      { letter: 'a', label: 'Merge now', consequence: 'Ships with the Sonar warning unresolved.' },
      { letter: 'b', label: 'Fix the Sonar warning first', consequence: 'Delays merge by one review cycle.' },
    ],
    rec: { letter: 'b', why: 'The warning is trivial to fix and blocks a clean Sonar gate.' },
    evidence: {
      authority: { canActWithoutHuman: false, rule: 'merges require an explicit human ruling' },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordApprovalRequested.mockResolvedValue(undefined);
  mockGetOperatorDid.mockResolvedValue(OPERATOR_DID);
});

describe('emitDecisionCard', () => {
  it('writes an operator.approvals row with kind decision:card, following the recordApprovalRequested pattern', async () => {
    const result = await emitDecisionCard(input());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(mockRecordApprovalRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: 'dcard_fixed',
        operatorDid: OPERATOR_DID,
        source: DECISION_APPROVAL_SOURCE,
        kind: DECISION_APPROVAL_KIND,
        keysTouched: [],
        notificationId: null,
      }),
    );
    expect(DECISION_APPROVAL_KIND).toBe('decision:card');
  });

  it('uses the card id as the proposalId — one card, one proposal', async () => {
    await emitDecisionCard(input({ id: 'dcard_specific' }));
    expect(mockRecordApprovalRequested).toHaveBeenCalledWith(expect.objectContaining({ proposalId: 'dcard_specific' }));
  });

  it('stores the full card as detail and the card contentHash as contentHash', async () => {
    const built = createDecisionCard(input());
    if (!built.ok) throw new Error('expected ok');

    await emitDecisionCard(input());

    expect(mockRecordApprovalRequested).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ id: 'dcard_fixed' }), contentHash: built.card.contentHash }),
    );
  });

  it('returns the built card and its prose render', async () => {
    const result = await emitDecisionCard(input());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.card.id).toBe('dcard_fixed');
    expect(result.prose).toContain('DECISION · #2315 · Merge #2315 now?');
    expect(result.prose).toContain('ev:');
  });

  it('fails without writing a row when the DecisionCard input is invalid', async () => {
    const result = await emitDecisionCard(input({ question: '' }));
    expect(result.ok).toBe(false);
    expect(mockRecordApprovalRequested).not.toHaveBeenCalled();
  });

  it('fails without writing a row when no operator DID is configured', async () => {
    mockGetOperatorDid.mockResolvedValue(null);
    const result = await emitDecisionCard(input());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/operator/i);
    expect(mockRecordApprovalRequested).not.toHaveBeenCalled();
  });

  it('reports a failure (never throws) when recordApprovalRequested rejects', async () => {
    mockRecordApprovalRequested.mockRejectedValueOnce(new Error('db unavailable'));
    const result = await emitDecisionCard(input());
    expect(result.ok).toBe(false);
  });
});

describe('renderDecisionCardProse', () => {
  it('renders DECISION · subject · question · a) … b) … · rec: <letter> — <why>', () => {
    const built = createDecisionCard(input());
    if (!built.ok) throw new Error('expected ok');

    const prose = renderDecisionCardProse(built.card);
    const [header] = prose.split('\n');

    expect(header).toBe(
      'DECISION · #2315 · Merge #2315 now? · a) Merge now · b) Fix the Sonar warning first · ' +
        'rec: b — The warning is trivial to fix and blocks a clean Sonar gate.',
    );
  });
});

describe('renderDecisionCardEvidenceLine', () => {
  it('renders every evidence key with `?` when the evidence bundle only has authority', () => {
    const line = renderDecisionCardEvidenceLine({ authority: { canActWithoutHuman: false, rule: 'x' } });
    expect(line).toBe('ev: pr=? ci=? sonar=? review=? run=? blockers=? authority=human');
  });

  it('never omits a key even when every other kind of evidence is present', () => {
    const line = renderDecisionCardEvidenceLine({
      authority: { canActWithoutHuman: true, rule: 'x' },
      pr: { number: 42, title: 't', draft: false, mergeable: true, base: 'main', head: 'feat', headSha: 'abc', filesChanged: 1, additions: 1, deletions: 0, closes: [] },
      ci: { conclusion: 'success', checks: [] },
      sonar: { qualityGate: 'passed', newIssues: 0, coverageOnNew: 100, url: 'https://x' },
      review: { verdict: 'APPROVE-READY', model: 'x', sessionId: 'x', blocking: [], nonBlocking: [], commentUrl: 'https://x' },
      run: { warpRunId: 'run_1', status: 'succeeded', durationMs: 1000, resumes: 0, branches: [] },
      blockers: { blockedBy: [], blocks: [{ number: 1, state: 'open' }] },
    });

    for (const key of ['pr', 'ci', 'sonar', 'review', 'run', 'blockers', 'authority']) {
      expect(line).toContain(`${key}=`);
    }
    expect(line).not.toContain('=?');
  });
});
