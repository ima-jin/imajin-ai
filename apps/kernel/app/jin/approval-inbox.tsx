'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { approvalCardAnchorId } from './approval-anchor';
import { isApprovalActionable, type ApprovalAttention } from '@/src/lib/notify/approval-attention';

interface InboxCard extends ApprovalAttention {
  proposalId: string;
  actionable?: boolean;
}

export function isDecidedCard(card: InboxCard): boolean {
  return card.status !== 'pending';
}

/** One history toggle for every source, including each reader's archived cards. */
export function ApprovalInbox<T extends InboxCard>({
  approvals, deepLinkedProposalId, renderCards, onHistoryChange,
}: Readonly<{
  approvals: T[];
  deepLinkedProposalId: string | null;
  renderCards: (cards: T[]) => ReactNode;
  onHistoryChange?: (shown: boolean) => void;
}>) {
  const [showHistory, setShowHistory] = useState(false);
  const scrolledTo = useRef<string | null>(null);
  const actionable = (card: T) => card.actionable ?? isApprovalActionable(card);
  const visible = showHistory ? approvals : approvals.filter(actionable);

  useEffect(() => {
    if (!deepLinkedProposalId || scrolledTo.current === deepLinkedProposalId) return;
    const target = approvals.find(card => card.proposalId === deepLinkedProposalId);
    if ((!target || !(target.actionable ?? isApprovalActionable(target))) && !showHistory) {
      setShowHistory(true);
      onHistoryChange?.(true);
      return;
    }
    const element = document.getElementById(approvalCardAnchorId(deepLinkedProposalId));
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      scrolledTo.current = deepLinkedProposalId;
    }
  }, [approvals, deepLinkedProposalId, showHistory, onHistoryChange]);

  return (
    <div className="space-y-4">
      <button type="button" aria-expanded={showHistory} aria-controls="approval-history"
        onClick={() => {
          const shown = !showHistory;
          setShowHistory(shown);
          onHistoryChange?.(shown);
        }}
        className="min-h-11 rounded bg-gray-800 px-3 text-xs text-gray-300">
        {showHistory ? 'Hide history' : 'Show history'}
      </button>
      {showHistory && <p className="text-xs text-gray-500">History includes archived cards. Signed records are retained; nothing is deleted.</p>}
      <div id="approval-history">
        {visible.length ? renderCards(visible) : <p className="py-4 text-sm text-gray-500">No actionable approvals.</p>}
      </div>
    </div>
  );
}
