// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApprovalInbox } from '../approval-inbox';
import { ApprovalCardRow, type OperatorApprovalCard } from '../operator-approvals-panel';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
afterEach(cleanup);

function card(status = 'pending', change: Partial<OperatorApprovalCard> = {}): OperatorApprovalCard {
  return {
    proposalId: status, source: 'system-agent', kind: 'system-agent:restart', summary: `Card ${status}`,
    keysTouched: [], detail: null, contentHash: 'test-hash', status: status as OperatorApprovalCard['status'],
    decision: null, outcome: null, appliedAt: null, createdAt: new Date().toISOString(), ...change,
  };
}
function rows(cards: OperatorApprovalCard[]) {
  return cards.map(approval => <ApprovalCardRow key={approval.proposalId} approval={approval}
    onDecide={vi.fn()} onArchive={vi.fn()} busy={false} highlighted={false} decisionsLocked={false} />);
}
describe('Inbox history and actionable cards', () => {
  it('hides all terminal states and archives by default, then toggles them without modifying records', () => {
    const cards = ['pending', 'approved', 'denied', 'withdrawn', 'applied', 'expired'].map(status => card(status));
    cards.push(card('approved', { proposalId: 'archived', summary: 'Archived card', archivedAt: new Date().toISOString() }));
    const before = structuredClone(cards);
    const onHistoryChange = vi.fn();
    const { container } = render(<ApprovalInbox approvals={cards} deepLinkedProposalId={null} renderCards={rows} onHistoryChange={onHistoryChange} />);
    expect(screen.getByText('Card pending')).toBeDefined();
    expect(screen.getByText('Card approved')).toBeDefined();
    expect(screen.queryByText('Card expired')).toBeNull();
    expect(container.querySelectorAll('time')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }));
    for (const status of ['denied', 'withdrawn', 'applied', 'expired']) expect(screen.getByText(`Card ${status}`)).toBeDefined();
    expect(screen.getByText('Archived card')).toBeDefined();
    expect(container.querySelectorAll('time')).toHaveLength(7);
    expect(onHistoryChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Hide history' }));
    expect(screen.queryByText('Card expired')).toBeNull();
    expect(onHistoryChange).toHaveBeenLastCalledWith(false);
    expect(cards).toEqual(before);
  });
  it('honors server-configured actionability and labels expired pending-apply and gone source truth', () => {
    const cards = [
      card('pending', { actionable: false, summary: 'Configured deadline elapsed' }),
      card('expired', { outcome: { approvalExpiry: { previousStatus: 'approved', reason: 'not applied before approval deadline' } } }),
      card('expired', { proposalId: 'gone', summary: 'Gone source', outcome: { approvalExpiry: { previousStatus: 'pending', reason: 'source reports gone' } } }),
    ];
    render(<ApprovalInbox approvals={cards} deepLinkedProposalId={null} renderCards={rows} />);
    expect(screen.getByText('No actionable approvals.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }));
    expect(screen.getByText(/expired \(not applied\)/)).toBeDefined();
    expect(screen.getByText(/source reports gone/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });
  it('puts overdue pending/approved cards behind history, including signed native outcomes', () => {
    const cards = [
      card('pending', { createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString() }),
      card('approved', { detail: { expiresAt: '2000-01-01T00:00:00Z' } }),
      card('approved', { proposalId: 'native', sessionBinding: { loopId: 'loop', principalDid: 'principal', agentDid: 'agent', approvalId: 'approval' } }),
    ];
    render(<ApprovalInbox approvals={cards} deepLinkedProposalId={null} renderCards={rows} />);
    expect(screen.getByText('No actionable approvals.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }));
    expect(screen.getByText('8d old')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });
});
