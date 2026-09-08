// @vitest-environment jsdom
/**
 * Component tests for the /jin operator-approvals panel (#2059): the
 * operator-only visibility gate, the empty/pending/approved render states,
 * and the Approve/Deny/Withdraw click paths against `GET`/`POST
 * /jin/api/operator-approvals`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { OperatorApprovalsPanel } from '../operator-approvals-panel';
import { installIntervalSpy } from './panel-test-support';

interface ApprovalFixture {
  proposalId: string;
  kind: 'restart' | 'config-mutation' | 'other';
  summary: string;
  keysTouched: string[];
  status: 'pending' | 'approved' | 'denied' | 'withdrawn' | 'applied';
  decision: null;
  appliedAt: string | null;
  createdAt: string;
}

function approval(overrides: Partial<ApprovalFixture> = {}): ApprovalFixture {
  return {
    proposalId: 'opap_1',
    kind: 'restart',
    summary: 'Restart the gateway to load the updated plugin.',
    keysTouched: ['gateway.plugins.openclaw.version'],
    status: 'pending',
    decision: null,
    appliedAt: null,
    createdAt: new Date('2026-09-08T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

/** Installs a fetch stub: GET list responses come from `listResponses` in order; any POST decision call resolves with `decisionResponse`. */
function installFetch(
  listResponses: Array<{ isOperator: boolean; approvals: ApprovalFixture[] }>,
  decisionResponse: { ok: boolean; status?: number; body?: unknown } = { ok: true, body: { approval: approval({ status: 'approved' }) } },
) {
  let callIndex = 0;
  const spy = vi.fn((url: string) => {
    if (url.includes('/decision')) {
      return Promise.resolve({
        ok: decisionResponse.ok,
        status: decisionResponse.status ?? (decisionResponse.ok ? 200 : 400),
        json: async () => decisionResponse.body ?? {},
      } as unknown as Response);
    }
    const listResponse = listResponses[Math.min(callIndex, listResponses.length - 1)];
    callIndex += 1;
    return Promise.resolve({ ok: true, status: 200, json: async () => listResponse } as unknown as Response);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('non-operator visibility (#2059 acceptance (c))', () => {
  it('renders nothing at all — no header, no empty state — for a non-operator', async () => {
    const spy = installFetch([{ isOperator: false, approvals: [] }]);
    const { container } = render(<OperatorApprovalsPanel />);

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('Operator approvals')).toBeNull();
  });

  it('renders nothing while the initial operator check is still loading', () => {
    installFetch([{ isOperator: true, approvals: [] }]);
    const { container } = render(<OperatorApprovalsPanel />);

    // Before the fetch resolves, isOperator is still its initial `false`.
    expect(container.firstChild).toBeNull();
  });
});

describe('operator — empty state', () => {
  it('shows the panel header and empty-state copy when there are no proposals', async () => {
    installFetch([{ isOperator: true, approvals: [] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText('Operator approvals')).toBeDefined();
    expect(screen.getByText('No operator approvals yet.')).toBeDefined();
  });
});

describe('operator — pending proposal', () => {
  it('renders the summary, kind badge, keys touched, and Approve/Deny controls', async () => {
    installFetch([{ isOperator: true, approvals: [approval()] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText('Restart the gateway to load the updated plugin.')).toBeDefined();
    expect(screen.getByText('restart')).toBeDefined();
    expect(screen.getByText('gateway.plugins.openclaw.version')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('shows the server error message and does not refresh when the decision request fails', async () => {
    installFetch(
      [{ isOperator: true, approvals: [approval()] }],
      { ok: false, status: 403, body: { error: 'Only the node operator may decide this proposal' } },
    );
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Approve' });

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Only the node operator may decide this proposal')).toBeDefined();
  });

  it('falls back to a generic error message when the failure response has no error field', async () => {
    installFetch([{ isOperator: true, approvals: [approval()] }], { ok: false, status: 500, body: {} });
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Approve' });

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Decision failed (500)')).toBeDefined();
  });
});

describe('operator — approved (pending-apply) proposal', () => {
  it('shows the Withdraw control instead of Approve/Deny', async () => {
    installFetch([{ isOperator: true, approvals: [approval({ status: 'approved' })] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByRole('button', { name: 'Withdraw' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });
});

// Approve/Deny/Withdraw share the same request/refresh shape (post the
// decision, flash "Proposal <decision>.", then show the refreshed status) —
// parameterized instead of three near-identical test bodies.
describe.each([
  { buttonName: 'Approve', decision: 'approve', from: approval(), to: approval({ status: 'approved' }), resultingStatusText: 'approved — pending apply' },
  { buttonName: 'Deny', decision: 'deny', from: approval(), to: approval({ status: 'denied' }), resultingStatusText: 'denied' },
  { buttonName: 'Withdraw', decision: 'withdrawn', from: approval({ status: 'approved' }), to: approval({ status: 'withdrawn' }), resultingStatusText: 'withdrawn' },
])('operator — $buttonName action', ({ buttonName, decision, from, to, resultingStatusText }) => {
  it(`posts decision=${decision} and refreshes to the new state`, async () => {
    const spy = installFetch(
      [{ isOperator: true, approvals: [from] }, { isOperator: true, approvals: [to] }],
      { ok: true, body: { approval: to } },
    );
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: buttonName });

    fireEvent.click(screen.getByRole('button', { name: buttonName }));

    await waitFor(() => expect(screen.getByText(`Proposal ${decision}.`)).toBeDefined());
    const decisionCall = spy.mock.calls.find(([url]) => String(url).includes('/decision'));
    expect(decisionCall?.[0]).toBe('/jin/api/operator-approvals/opap_1/decision');
    expect(decisionCall?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ decision }),
    });
    await waitFor(() => expect(screen.getByText(resultingStatusText)).toBeDefined());
  });
});

describe('terminal statuses', () => {
  it('shows no action controls for an applied proposal', async () => {
    installFetch([{ isOperator: true, approvals: [approval({ status: 'applied' })] }]);
    render(<OperatorApprovalsPanel />);

    await screen.findByText('applied');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('shows no action controls for a denied proposal', async () => {
    installFetch([{ isOperator: true, approvals: [approval({ status: 'denied' })] }]);
    render(<OperatorApprovalsPanel />);

    await screen.findByText('denied');
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });
});

describe('poll refresh', () => {
  it('registers a poll interval and silently refetches the list on each tick', async () => {
    const callbacks = installIntervalSpy();
    const spy = installFetch([
      { isOperator: true, approvals: [approval()] },
      { isOperator: true, approvals: [approval({ status: 'approved' })] },
    ]);
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Approve' });
    expect(spy).toHaveBeenCalledTimes(1);

    callbacks[0]();

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('approved — pending apply')).toBeDefined();
  });

  it('clears the poll interval on unmount', async () => {
    installIntervalSpy();
    installFetch([{ isOperator: true, approvals: [] }]);
    const { unmount } = render(<OperatorApprovalsPanel />);
    await screen.findByText('Operator approvals');

    unmount();

    expect(globalThis.clearInterval).toHaveBeenCalled();
  });
});

describe('network failure', () => {
  it('does not throw and stays hidden when the initial fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { container } = render(<OperatorApprovalsPanel />);

    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});

describe('manual refresh', () => {
  it('refetches the list when the refresh button is clicked', async () => {
    const spy = installFetch([
      { isOperator: true, approvals: [] },
      { isOperator: true, approvals: [approval()] },
    ]);
    render(<OperatorApprovalsPanel />);
    await screen.findByText('No operator approvals yet.');

    fireEvent.click(screen.getByRole('button', { name: '↺ refresh' }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Restart the gateway to load the updated plugin.')).toBeDefined();
  });
});
