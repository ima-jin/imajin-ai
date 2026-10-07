// @vitest-environment jsdom
/**
 * Component tests for the `decision` source renderer on the /jin operator-
 * approvals panel (#2323): header, a/b/c options as countersign buttons,
 * `rec` marking, the `ev:` strip (incl. `?` for missing), the decision
 * payload shape, "none of these", the decided-card chosen option, and one
 * round-trip from the #2315 emitter fixture through the panel to the POST.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import type { DecisionCardInput } from '@/src/lib/decisions/schema';

const searchParamsMock = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsMock.current,
}));

// The emitter's server-side collaborators — same mocks `emit.test.ts` uses.
const { mockRecordApprovalRequested, mockGetOperatorDid } = vi.hoisted(() => ({
  mockRecordApprovalRequested: vi.fn().mockResolvedValue(undefined),
  mockGetOperatorDid: vi.fn(),
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/src/lib/notify/operator-approvals-service', () => ({
  recordApprovalRequested: mockRecordApprovalRequested,
}));
vi.mock('@/src/lib/notify/operator-approvals', () => ({
  getOperatorDid: mockGetOperatorDid,
}));

import { OperatorApprovalsPanel } from '../operator-approvals-panel';
import { emitDecisionCard } from '@/src/lib/decisions/emit';

interface ApprovalFixture {
  proposalId: string;
  source: string;
  kind: string;
  summary: string;
  keysTouched: string[];
  detail: Record<string, unknown> | null;
  contentHash: string;
  status: 'pending' | 'approved' | 'denied' | 'withdrawn' | 'applied' | 'expired';
  decision: { decidedBy: string; decidedAt: string; mode?: string } | null;
  outcome: null;
  appliedAt: string | null;
  createdAt: string;
}

const SUBJECT_URL = 'https://github.com/ima-jin/imajin-ai/pull/2323';

function cardDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dcard_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'review',
    subject: { kind: 'pr', ref: '#2323', url: SUBJECT_URL },
    question: 'Merge #2323 now?',
    options: [
      { letter: 'a', label: 'Merge now', consequence: 'Ships with the Sonar warning unresolved.' },
      { letter: 'b', label: 'Fix the Sonar warning first', consequence: 'Delays merge by one review cycle.' },
      { letter: 'c', label: 'Close the PR', consequence: 'Drops the work.' },
    ],
    rec: { letter: 'b', why: 'The warning is trivial to fix.' },
    evidence: {
      pr: {
        number: 2323,
        title: 'feat',
        draft: false,
        mergeable: true,
        base: 'main',
        head: 'feat/x',
        headSha: 'abc',
        filesChanged: 3,
        additions: 10,
        deletions: 2,
        closes: [2323],
      },
      ci: { conclusion: 'success', checks: [] },
      authority: { canActWithoutHuman: false, rule: 'merges require a human ruling' },
    },
    ...overrides,
  };
}

function decisionApproval(overrides: Partial<ApprovalFixture> = {}): ApprovalFixture {
  return {
    proposalId: 'dcard_1',
    source: 'decision',
    kind: 'decision:card',
    summary: 'DECISION · #2323 · Merge #2323 now?',
    keysTouched: [],
    detail: cardDetail(),
    contentHash: 'a'.repeat(64),
    status: 'pending',
    decision: null,
    outcome: null,
    appliedAt: null,
    createdAt: new Date('2026-09-08T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function installFetch(approvals: ApprovalFixture[]) {
  const spy = vi.fn((url: string) => {
    if (url.includes('/decision')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ approval: approvals[0] }) } as unknown as Response);
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ isOperator: true, approvals }) } as unknown as Response);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function decisionCall(spy: ReturnType<typeof installFetch>) {
  const call = spy.mock.calls.find(([url]) => String(url).includes('/decision'));
  return {
    url: String(call?.[0]),
    body: JSON.parse((call?.[1] as { body: string }).body) as Record<string, unknown>,
  };
}

beforeEach(() => {
  searchParamsMock.current = new URLSearchParams();
});

afterEach(() => {
  cleanup();
  localStorage.removeItem('imajin_keypair');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('decision card — header', () => {
  it('renders the subject as a link and the one-line question', async () => {
    installFetch([decisionApproval()]);
    render(<OperatorApprovalsPanel />);

    const link = await screen.findByRole('link', { name: '#2323' });
    expect(link.getAttribute('href')).toBe(SUBJECT_URL);
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('Merge #2323 now?')).toBeDefined();
  });

  it('renders a non-http(s) subject url as plain text, never an href', async () => {
    installFetch([
      decisionApproval({ detail: cardDetail({ subject: { kind: 'pr', ref: '#9', url: 'javascript:alert(1)' } }) }),
    ]);
    render(<OperatorApprovalsPanel />);

    await screen.findByText('#9');
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('decision card — options', () => {
  it('renders every option a/b/c as a button with its consequence, and no Approve/Deny pair', async () => {
    installFetch([decisionApproval()]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByRole('button', { name: 'a) Merge now' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'b) Fix the Sonar warning first' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'c) Close the PR' })).toBeDefined();
    expect(screen.getByText('Ships with the Sonar warning unresolved.')).toBeDefined();
    expect(screen.getByText('Delays merge by one review cycle.')).toBeDefined();
    expect(screen.getByText('Drops the work.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  it('marks only the recommended option, with the rec reason inline', async () => {
    installFetch([decisionApproval()]);
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'a) Merge now' });

    const recs = screen.getAllByTestId('decision-rec');
    expect(recs).toHaveLength(1);
    expect(within(screen.getByTestId('decision-option-b')).getByTestId('decision-rec').textContent).toContain(
      'The warning is trivial to fix.',
    );
    expect(within(screen.getByTestId('decision-option-a')).queryByTestId('decision-rec')).toBeNull();
    expect(within(screen.getByTestId('decision-option-c')).queryByTestId('decision-rec')).toBeNull();
  });

  it('offers None of these as the unchanged reject', async () => {
    const spy = installFetch([decisionApproval()]);
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'None of these' });

    fireEvent.click(screen.getByRole('button', { name: 'None of these' }));

    await waitFor(() => expect(screen.getByText('Proposal reject.')).toBeDefined());
    expect(decisionCall(spy).body).toEqual({ decision: 'reject' });
  });

  it('falls back to the summary and only offers None of these when detail is not a usable card', async () => {
    installFetch([decisionApproval({ detail: { not: 'a card' } })]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText('DECISION · #2323 · Merge #2323 now?')).toBeDefined();
    expect(screen.getByRole('button', { name: 'None of these' })).toBeDefined();
    expect(screen.getAllByRole('button').filter((b) => /^[a-z]\)/.test(b.textContent ?? ''))).toHaveLength(0);
  });
});

describe('decision card — ev strip', () => {
  it('renders every ev field as key/value, with ? for missing evidence', async () => {
    installFetch([decisionApproval()]);
    render(<OperatorApprovalsPanel />);
    await screen.findByTestId('decision-ev');

    const value = (key: string) => within(screen.getByTestId(`decision-ev-${key}`)).getByText(/.+/, { selector: 'dd' }).textContent;
    expect(value('pr')).toBe('#2323(ready,mergeable)');
    expect(value('ci')).toBe('success');
    expect(value('authority')).toBe('human');
    for (const missing of ['sonar', 'review', 'run', 'blockers']) {
      expect(value(missing)).toBe('?');
    }
  });

  it('still renders the full strip, all ?, when evidence is absent from the row', async () => {
    installFetch([decisionApproval({ detail: cardDetail({ evidence: undefined }) })]);
    render(<OperatorApprovalsPanel />);
    await screen.findByTestId('decision-ev');

    const strip = screen.getByTestId('decision-ev');
    const values = within(strip)
      .getAllByText(/.+/, { selector: 'dd' })
      .map((dd) => dd.textContent);
    expect(values).toEqual(['?', '?', '?', '?', '?', '?', '?']);
  });
});

describe('decision card — decision payload', () => {
  it.each([
    ['a', 'a) Merge now'],
    ['b', 'b) Fix the Sonar warning first'],
    ['c', 'c) Close the PR'],
  ])('choosing %s posts decision=approve with mode=%s to the existing decision route', async (letter, buttonName) => {
    const spy = installFetch([decisionApproval()]);
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: buttonName });

    fireEvent.click(screen.getByRole('button', { name: buttonName }));

    await waitFor(() => expect(screen.getByText('Proposal approve.')).toBeDefined());
    const { url, body } = decisionCall(spy);
    expect(url).toBe('/jin/api/operator-approvals/dcard_1/decision');
    expect(body).toEqual({ decision: 'approve', mode: letter });
  });

  it('adds only decidedAt + operatorSignature when a local keypair signs the choice', async () => {
    const { privateKey, publicKey } = authCrypto.generateKeypair();
    localStorage.setItem('imajin_keypair', JSON.stringify({ privateKey, publicKey }));
    const spy = installFetch([decisionApproval()]);
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'c) Close the PR' });

    fireEvent.click(screen.getByRole('button', { name: 'c) Close the PR' }));

    await waitFor(() => expect(screen.getByText('Proposal approve.')).toBeDefined());
    const { body } = decisionCall(spy);
    expect(Object.keys(body).sort()).toEqual(['decidedAt', 'decision', 'mode', 'operatorSignature']);
    expect(body.mode).toBe('c');
  });
});

describe('decision card — decided states', () => {
  it('shows the chosen option on a decided card, with Withdraw instead of option buttons', async () => {
    installFetch([
      decisionApproval({ status: 'approved', decision: { decidedBy: 'did:imajin:operator', decidedAt: '2026-01-02T00:00:00.000Z', mode: 'b' } }),
    ]);
    render(<OperatorApprovalsPanel />);

    const chosen = await screen.findByTestId('decision-chosen');
    expect(chosen.textContent).toContain('b');
    expect(chosen.textContent).toContain('Fix the Sonar warning first');
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'a) Merge now' })).toBeNull();
  });

  it('shows no chosen option on a rejected (none of these) card', async () => {
    installFetch([
      decisionApproval({ status: 'denied', decision: { decidedBy: 'did:imajin:operator', decidedAt: '2026-01-02T00:00:00.000Z' } }),
    ]);
    render(<OperatorApprovalsPanel />);

    await screen.findByText('Merge #2323 now?');
    expect(screen.queryByTestId('decision-chosen')).toBeNull();
    expect(screen.queryByRole('button', { name: 'None of these' })).toBeNull();
  });
});

describe('decision card — round-trip from the #2315 emitter fixture', () => {
  const OPERATOR_DID = 'did:imajin:operator';

  function emitterInput(): DecisionCardInput {
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
    };
  }

  it('emits a card, renders it from the stored row, and signs + posts the chosen letter over its contentHash', async () => {
    mockGetOperatorDid.mockResolvedValue(OPERATOR_DID);
    mockRecordApprovalRequested.mockResolvedValue(undefined);

    const emitted = await emitDecisionCard(emitterInput());
    expect(emitted.ok).toBe(true);
    if (!emitted.ok) throw new Error('expected ok');

    // What `GET /jin/api/operator-approvals` would hand back for the row the emitter wrote.
    const written = mockRecordApprovalRequested.mock.calls[0][0] as {
      proposalId: string;
      source: string;
      kind: string;
      summary: string;
      keysTouched: string[];
      detail: Record<string, unknown>;
      contentHash: string;
    };
    const row = decisionApproval({
      proposalId: written.proposalId,
      source: written.source,
      kind: written.kind,
      summary: written.summary,
      keysTouched: written.keysTouched,
      detail: written.detail,
      contentHash: written.contentHash,
    });

    const { privateKey, publicKey } = authCrypto.generateKeypair();
    localStorage.setItem('imajin_keypair', JSON.stringify({ privateKey, publicKey }));
    const spy = installFetch([row]);
    render(<OperatorApprovalsPanel />);

    // Rendered from the emitter's own output: subject, question, options, rec, ev strip.
    expect((await screen.findByRole('link', { name: '#2315' })).getAttribute('href')).toBe(
      'https://github.com/ima-jin/imajin-ai/pull/2315',
    );
    expect(screen.getByText('Merge #2315 now?')).toBeDefined();
    expect(within(screen.getByTestId('decision-option-b')).getByTestId('decision-rec').textContent).toContain(
      'blocks a clean Sonar gate',
    );
    expect(within(screen.getByTestId('decision-ev-authority')).getByText('human')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'b) Fix the Sonar warning first' }));
    await waitFor(() => expect(screen.getByText('Proposal approve.')).toBeDefined());

    const { url, body } = decisionCall(spy);
    expect(url).toBe(`/jin/api/operator-approvals/${emitted.proposalId}/decision`);
    expect(body.decision).toBe('approve');
    expect(body.mode).toBe('b');

    // The countersignature covers the card's own contentHash.
    const signature = body.operatorSignature as { keyId: string; sig: string };
    const signed = canonicalize({ contentHash: emitted.card.contentHash, decidedAt: body.decidedAt, decision: 'approve' });
    expect(authCrypto.verifySync(signature.sig, signed, publicKey)).toBe(true);
  });
});
