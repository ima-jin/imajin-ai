'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { approvalCardAnchorId } from './approval-anchor';

interface InboxCard {
  proposalId: string;
  source: string;
  kind: string;
  status: string;
  archivedAt?: string | null;
}

export function isDecidedCard(card: InboxCard): boolean {
  return card.source === 'decision' && card.kind === 'decision:card' && card.status !== 'pending';
}

/** Archive changes visibility, never the decision's lifecycle or signed record. */
export function ApprovalInbox<T extends InboxCard>({
  approvals,
  deepLinkedProposalId,
  renderCards,
}: Readonly<{
  approvals: T[];
  deepLinkedProposalId: string | null;
  renderCards: (cards: T[]) => ReactNode;
}>) {
  const [showDecided, setShowDecided] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const scrolledTo = useRef<string | null>(null);
  const active = approvals.filter((card) => !isDecidedCard(card));
  const decided = approvals.filter(isDecidedCard);
  const archived = decided.filter((card) => card.archivedAt);
  const visibleDecided = decided.filter((card) => !card.archivedAt || showArchived);

  // A notification/record deep link must still find a collapsed or archived card.
  useEffect(() => {
    const target = approvals.find((card) => card.proposalId === deepLinkedProposalId);
    if (!target || scrolledTo.current === target.proposalId) return;
    if (isDecidedCard(target) && !showDecided) {
      setShowDecided(true);
      return;
    }
    if (isDecidedCard(target) && target.archivedAt && !showArchived) {
      setShowArchived(true);
      return;
    }
    const element = document.getElementById(approvalCardAnchorId(target.proposalId));
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      scrolledTo.current = target.proposalId;
    }
  }, [approvals, deepLinkedProposalId, showDecided, showArchived]);

  return (
    <div className="space-y-4">
      {active.length > 0 || decided.length === 0
        ? renderCards(active)
        : <p className="text-sm text-gray-500 py-4">No active approvals.</p>}
      {decided.length > 0 && (
        <section aria-label="Decided approvals" className="rounded-lg border border-gray-800 p-3 space-y-3">
          <button
            type="button"
            aria-expanded={showDecided}
            aria-controls="decided-approvals"
            onClick={() => setShowDecided((shown) => !shown)}
            className="min-h-11 w-full flex flex-wrap items-center justify-between gap-2 text-sm text-gray-200"
          >
            <span>Decided ({decided.length})</span>
            <span className="text-gray-400">{showDecided ? 'Hide decided' : 'Reveal decided'}</span>
          </button>
          {showDecided && (
            <div id="decided-approvals" className="space-y-3">
              <p className="text-xs text-gray-500">Decisions stay on record. Archive only hides a card; it does not apply or delete it.</p>
              {archived.length > 0 && (
                <button
                  type="button"
                  aria-expanded={showArchived}
                  aria-controls="decided-cards"
                  onClick={() => setShowArchived((shown) => !shown)}
                  className="min-h-11 px-3 rounded text-xs text-gray-300 bg-gray-800 hover:bg-gray-700"
                >
                  {showArchived ? 'Hide archived' : 'Show archived'} ({archived.length})
                </button>
              )}
              <div id="decided-cards">
                {visibleDecided.length > 0
                  ? renderCards(visibleDecided)
                  : <p className="text-sm text-gray-500">All decided cards are archived.</p>}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
