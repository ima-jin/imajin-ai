'use client';

import { useState } from 'react';
import {
  ApprovalCardRow,
  ApprovalControllerNotices,
  useRunApprovals,
  type OperatorApprovalCard,
} from './operator-approvals-panel';
import { DECISION_APPROVAL_KIND, DECISION_APPROVAL_SOURCE, parseDecisionCardView } from '@/src/lib/decisions/view';

const UNKNOWN_AGENT = 'Not recorded';
const SELECT_CLASS = 'min-h-11 min-w-0 w-full border border-gray-700 bg-gray-900 p-2 text-sm text-gray-200';

function subjectOf(card: OperatorApprovalCard): string {
  const subject = parseDecisionCardView(card.detail)?.subject;
  return subject ? `${subject.kind}: ${subject.ref}` : 'Subject not recorded';
}
function creationTime(card: OperatorApprovalCard): number {
  const time = Date.parse(card.createdAt);
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

function agentOf(card: OperatorApprovalCard): string {
  return card.signerDid || UNKNOWN_AGENT;
}

function ageInDays(createdAt: string): string {
  const days = Math.floor((Date.now() - Date.parse(createdAt)) / 86_400_000);
  return Number.isFinite(days) ? `${Math.max(0, days)}d` : '?d';
}

function DecisionRow({ card, controller }: Readonly<{
  card: OperatorApprovalCard;
  controller: ReturnType<typeof useRunApprovals>;
}>) {
  const view = parseDecisionCardView(card.detail);
  return (
    <details className="min-w-0 border border-gray-800 bg-[#12121a]">
      <summary className="min-h-11 cursor-pointer p-3">
        <span className="flex min-w-0 items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block break-words font-mono text-sm text-gray-200">{subjectOf(card)}</span>
            <span className="block truncate text-sm text-gray-300">{view?.question ?? card.summary}</span>
            <span className="block truncate text-xs text-green-300">
              rec: {view ? `${view.rec.letter} — ${view.rec.why}` : 'Not recorded'}
            </span>
            <span className="block break-all text-xs text-gray-500">agent: {agentOf(card)}</span>
          </span>
          <time dateTime={card.createdAt} title={card.createdAt} className="shrink-0 font-mono text-sm text-amber-300">
            {ageInDays(card.createdAt)}
          </time>
        </span>
      </summary>
      <ApprovalCardRow approval={card} onDecide={controller.handleDecide} onArchive={controller.handleArchive}
        busy={controller.busyId === card.proposalId} highlighted={false}
        decisionsLocked={controller.decisionsLocked} anchor={false} />
    </details>
  );
}

function DecisionGroup({ label, cards, controller }: Readonly<{
  label: string;
  cards: OperatorApprovalCard[];
  controller: ReturnType<typeof useRunApprovals>;
}>) {
  if (cards.length === 0) return null;
  return (
    <details className="border border-gray-800 p-3">
      <summary className="min-h-11 cursor-pointer font-mono text-sm text-gray-400">{label} ({cards.length})</summary>
      <div className="space-y-2">{cards.map(card => <DecisionRow key={card.proposalId} card={card} controller={controller} />)}</div>
    </details>
  );
}

/** A view of the Inbox's retained, principal-scoped projection, not another decision rail. */
export function DecisionsPanel() {
  const controller = useRunApprovals(undefined, { source: DECISION_APPROVAL_SOURCE, includeHistory: true });
  const [subject, setSubject] = useState('');
  const [agent, setAgent] = useState('');
  const cards = controller.approvals
    .filter(card => card.source === DECISION_APPROVAL_SOURCE && card.kind === DECISION_APPROVAL_KIND)
    .sort((a, b) => creationTime(a) - creationTime(b) || a.proposalId.localeCompare(b.proposalId));
  const filtered = cards.filter(card => (!subject || subjectOf(card) === subject) && (!agent || agentOf(card) === agent));
  const open = filtered.filter(card => card.status === 'pending' && !card.appliedAt);
  const pendingApply = filtered.filter(card => card.status === 'approved' && !card.appliedAt);
  const applied = filtered.filter(card => card.status === 'applied' || Boolean(card.appliedAt));
  const other = filtered.filter(card => !['pending', 'approved', 'applied'].includes(card.status) && !card.appliedAt);

  if (!controller.isOperator && !controller.actAs && cards.length === 0) return null;
  return (
    <>
      <nav aria-label="Jin lanes" className="mb-4 flex flex-wrap border-b border-gray-800 font-mono">
        <a href="#decisions" aria-label={`Decisions — ${open.length} open`} className="min-h-11 px-3 py-3 text-amber-400">
          Decisions <span aria-hidden="true">({open.length})</span>
        </a>
      </nav>
      <section id="decisions" aria-label="Decisions" className="min-w-0 space-y-3">
        <h2 className="font-mono text-base text-gray-100">Decisions</h2>
        <p className="text-xs text-gray-500">Open decisions, oldest first. Expand a row to rule in place.</p>
        <ApprovalControllerNotices controller={controller} />
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="min-w-0 text-xs text-gray-400">Subject
            <select className={SELECT_CLASS} value={subject} onChange={event => setSubject(event.target.value)}>
              <option value="">All subjects</option>
              {[...new Set(cards.map(subjectOf))].map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="min-w-0 text-xs text-gray-400">Agent
            <select className={SELECT_CLASS} value={agent} onChange={event => setAgent(event.target.value)}>
              <option value="">All agents</option>
              {[...new Set(cards.map(agentOf))].map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        {controller.loading && <p className="text-sm text-gray-500">Loading decisions…</p>}
        {!controller.loading && open.length === 0 && <p className="text-sm text-gray-500">No open decisions.</p>}
        <div aria-label="Open decisions" className="space-y-2">
          {open.map(card => <DecisionRow key={card.proposalId} card={card} controller={controller} />)}
        </div>
        <DecisionGroup label="Ruled, pending apply" cards={pendingApply} controller={controller} />
        <DecisionGroup label="Applied" cards={applied} controller={controller} />
        <DecisionGroup label="Other ruled decisions" cards={other} controller={controller} />
      </section>
    </>
  );
}
