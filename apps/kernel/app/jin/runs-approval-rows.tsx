'use client';

import { ApprovalCardRow, type OperatorApprovalCard, type useRunApprovals } from './operator-approvals-panel';


export function RunApprovalRows({ cards, controller }: Readonly<{
  cards: OperatorApprovalCard[]; controller: ReturnType<typeof useRunApprovals>;
}>) {
  return <div className="min-w-0 space-y-2">
    {cards.map((card) => <div key={card.proposalId} className="min-w-0">
      <p className="break-all text-xs text-gray-400">{card.sessionBinding ? `Bound to loop ${card.sessionBinding.loopId}` : 'No verified loop binding · pending approval'}</p>
      <ApprovalCardRow approval={card} onDecide={controller.handleDecide} busy={controller.busyId === card.proposalId} highlighted={false} decisionsLocked={controller.decisionsLocked} onArchive={controller.handleArchive} anchor={false} />
    </div>)}
  </div>;
}
