// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { DecisionsPanel } from '../decisions-panel';
import type { OperatorApprovalCard } from '../operator-approvals-panel';

function card(id: string, days = 0, overrides: Partial<OperatorApprovalCard> = {}): OperatorApprovalCard {
  return {
    proposalId: id, source: 'decision', kind: 'decision:card', summary: `Decision ${id}`,
    keysTouched: [], contentHash: 'a'.repeat(64), status: 'pending', decision: null,
    outcome: null, appliedAt: null, createdAt: new Date(Date.now() - days * 86_400_000).toISOString(),
    signerDid: 'did:imajin:agent-a',
    detail: {
      subject: { kind: 'issue', ref: `#${id}`, url: `https://example.test/issues/${id}` },
      question: `Rule on ${id}?`,
      options: [{ letter: 'a', label: 'Proceed', consequence: 'Continue' }, { letter: 'b', label: 'Wait', consequence: 'Pause' }],
      rec: { letter: 'b', why: 'More evidence needed' },
    },
    ...overrides,
  };
}

function install(cards: OperatorApprovalCard[], extra: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ isOperator: true, approvals: cards, ...extra }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function openRows(): HTMLDetailsElement[] {
  return Array.from(document.querySelector('[aria-label="Open decisions"]')!.querySelectorAll('details'));
}

async function loaded(count: number) {
  await screen.findByRole('link', { name: `Decisions — ${count} open` });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Decisions lane (#3058)', () => {
  it('reads the existing scoped rail with history, shows every open row oldest first and excludes other kinds', async () => {
    const fetchMock = install([
      card('new'), card('old', 4), card('middle', 2),
      card('other', 1, { source: 'github', kind: 'github:write' }),
      card('wrong-kind', 1, { kind: 'decision:other' }),
    ]);
    render(<DecisionsPanel />);
    await loaded(3);
    expect(fetchMock.mock.calls[0][0]).toBe('/jin/api/operator-approvals?view=acting&history=true&source=decision');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include', cache: 'no-store', headers: {} });
    expect(openRows().map(row => row.querySelector('summary')!.textContent)).toEqual([
      expect.stringContaining('issue: #old'), expect.stringContaining('issue: #middle'), expect.stringContaining('issue: #new'),
    ]);
    expect(openRows().map(row => row.querySelector('time')!.textContent)).toEqual(['4d', '2d', '0d']);
    expect(openRows()[0].querySelector('summary')!.textContent).toContain('Rule on old?rec: b — More evidence needed');
    expect(fetchMock.mock.calls.every(([url]) => url.startsWith('/jin/api/operator-approvals'))).toBe(true);
    expect(screen.queryByText('Decision other')).toBeNull();
  });

  it('collapses ruled/pending apply separately from applied and other retained rulings', async () => {
    install([
      card('open'), card('ruled', 1, { status: 'approved', decision: { decidedBy: 'did:self', decidedAt: new Date().toISOString(), mode: 'b' } }),
      card('applied', 2, { status: 'applied', appliedAt: new Date().toISOString() }),
      card('rejected', 3, { status: 'denied' }), card('expired', 4, { status: 'expired' }),
      card('withdrawn', 1, { status: 'withdrawn', archivedAt: new Date().toISOString() }),
      card('applied-marker', 1, { status: 'approved', appliedAt: new Date().toISOString() }),
    ]);
    render(<DecisionsPanel />);
    await loaded(1);
    for (const label of ['Ruled, pending apply (1)', 'Applied (2)', 'Other ruled decisions (3)']) {
      expect(screen.getByText(label).closest('details')!.open).toBe(false);
    }
    expect(openRows()).toHaveLength(1);
    const group = screen.getByText('Ruled, pending apply (1)').closest('details')!;
    fireEvent.click(within(group).getByText('Ruled, pending apply (1)'));
    expect(within(group).getByTestId('decision-chosen').textContent).toContain('Wait');
    expect(within(group).queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('filters subject refs including PR/app and recorded agents together, with an exact matching nav count', async () => {
    const pr = card('pr');
    pr.detail!.subject = { kind: 'pr', ref: '#42', url: 'https://example.test/pull/42' };
    const app = card('app');
    // Rendering is open vocabulary; this does not add a new emitter schema kind.
    app.detail!.subject = { kind: 'app', ref: 'coffee', url: 'https://example.test/coffee' };
    install([card('one'), card('two', 0, { signerDid: 'did:imajin:agent-b' }), pr, app]);
    render(<DecisionsPanel />);
    await loaded(4);
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'pr: #42' } });
    await loaded(1);
    expect(openRows()[0].textContent).toContain('Rule on pr?');
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'did:imajin:agent-b' } });
    await loaded(0);
    expect(screen.getByText('No open decisions.')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'app: coffee' } });
    await loaded(1);
    expect(openRows()[0].textContent).toContain('Rule on app?');
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: '' } });
    await loaded(4);
  });

  it('opens the shared DecisionCard, countersigns the chosen letter, then moves it to pending apply and finally applied on refresh', async () => {
    const row = card('choose');
    const { privateKey, publicKey } = authCrypto.generateKeypair();
    localStorage.setItem('imajin_keypair', JSON.stringify({ privateKey, publicKey }));
    const fetchMock = install([row]);
    fetchMock.mockImplementation(async (url, init) => {
      if (url.endsWith('/decision')) {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ decision: 'approve', mode: 'b' });
        expect(authCrypto.verifySync(body.operatorSignature.sig, canonicalize({
          contentHash: row.contentHash, decidedAt: body.decidedAt, decision: 'approve', mode: 'b',
        }), publicKey)).toBe(true);
        row.status = 'approved';
        row.decision = { decidedBy: 'did:self', decidedAt: body.decidedAt, mode: body.mode };
        return Response.json({ approval: row });
      }
      return Response.json({ isOperator: true, approvals: [row] });
    });
    render(<DecisionsPanel />);
    await loaded(1);
    const details = openRows()[0];
    fireEvent.click(details.querySelector('summary')!);
    const choose = within(details).getByRole('button', { name: 'b) Wait' });
    expect(choose.className).toContain('min-h-11');
    expect(within(details).getByTestId('decision-ev')).toBeDefined();
    fireEvent.click(choose);
    await loaded(0);
    expect(screen.getByText('Ruled, pending apply (1)').closest('details')!.open).toBe(false);
    row.status = 'applied';
    row.appliedAt = new Date().toISOString();
    await act(async () => { globalThis.dispatchEvent(new Event('jin:operator-approvals-refresh')); });
    await screen.findByText('Applied (1)');
    expect(screen.queryByText('Ruled, pending apply (1)')).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/decision'))).toHaveLength(1);
  });

  it('retains the open row and count when a ruling is refused', async () => {
    const fetchMock = install([card('refused')]);
    fetchMock.mockImplementation(async url => url.endsWith('/decision')
      ? Response.json({ error: 'Countersignature required' }, { status: 400 })
      : Response.json({ isOperator: true, approvals: [card('refused')] }));
    render(<DecisionsPanel />);
    await loaded(1);
    fireEvent.click(openRows()[0].querySelector('summary')!);
    fireEvent.click(screen.getByRole('button', { name: 'None of these' }));
    await screen.findByText('Countersignature required');
    await loaded(1);
    expect(openRows()).toHaveLength(1);
  });

  it('keeps act-as decisions locked and does not infer an agent from the emission category', async () => {
    install([card('unknown', 0, { signerDid: null })], { actAs: { sessionDid: 'did:self', actingDid: 'did:org' } });
    render(<DecisionsPanel />);
    await loaded(1);
    fireEvent.click(openRows()[0].querySelector('summary')!);
    expect(screen.getByText('agent: Not recorded')).toBeDefined();
    expect(screen.getByTestId('act-as-locked')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'b) Wait' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'Not recorded' } });
    await loaded(1);
  });

  it('uses safe fallback rows for malformed cards, dates, and future dates without losing the count', async () => {
    install([card('malformed', 0, { detail: null, createdAt: 'invalid' }),
      card('future', -1)]);
    render(<DecisionsPanel />);
    await loaded(2);
    expect(screen.getByText('Subject not recorded', { selector: 'span' })).toBeDefined();
    expect(screen.getByText('rec: Not recorded')).toBeDefined();
    expect(openRows().map(row => row.querySelector('time')!.textContent)).toEqual(['0d', '?d']);
    expect(screen.getByLabelText('Subject').className).toContain('min-h-11');
    expect(screen.getByLabelText('Agent').className).toContain('w-full');
  });

  it.each([401, 403, 503])('does not show a lane or stale count on HTTP %s', async status => {
    const fetchMock = install([card('private')]);
    render(<DecisionsPanel />);
    await loaded(1);
    fetchMock.mockResolvedValue(Response.json({ error: 'Denied' }, { status }));
    await act(async () => { fireEvent.focus(window); });
    await waitFor(() => expect(screen.queryByRole('link', { name: /Decisions/ })).toBeNull());
    expect(screen.queryByText('Rule on private?')).toBeNull();
  });
});
