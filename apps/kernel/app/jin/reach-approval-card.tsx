'use client';

import { useState } from 'react';
import type { DecisionAction, OperatorApprovalCard } from './operator-approvals-panel';
export { isReachApproval } from '@/src/lib/notify/reach-approval-contract';

export type InboxDecisionHandler = (
  approval: OperatorApprovalCard, decision: DecisionAction, mode?: string, replyMessage?: string,
) => void;


function text(value: unknown, fallback = 'Not supplied'): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** Allowlisted evidence only: never render arbitrary JSON or gate configuration. */
export function ReachApprovalDetail({ approval }: Readonly<{ approval: OperatorApprovalCard }>) {
  const detail = approval.detail;
  const rawClaim = detail?.onBehalfOf;
  const claim = rawClaim && typeof rawClaim === 'object' ? rawClaim as Record<string, unknown> : {};
  const platform = text(claim.platform, 'unknown platform');
  const requester = text(detail?.requesterDid);
  const claimedHuman = text(claim.externalRef, 'Unknown person');
  const topic = text(detail?.topic, 'a message');
  const threadDid = approval.outcome?.conversationDid;
  return (
    <div className="min-w-0 space-y-3">
      <h3 className="break-words text-sm font-semibold text-gray-100">
        {claimedHuman}&apos;s agent ({platform}, unverified claim) about {topic}
      </h3>
      <p className="whitespace-pre-wrap break-words text-sm text-gray-200">{text(detail?.message)}</p>
      <dl className="space-y-1 break-all text-xs text-gray-400">
        <div><dt className="inline">Requester: </dt><dd className="inline font-mono">{requester}</dd></div>
        <div><dt className="inline">Tier: </dt><dd className="inline">{text(detail?.requesterTier, 'unknown')}</dd></div>
        <div><dt className="inline">Transcript hash: </dt><dd className="inline font-mono">{text(detail?.transcriptHash)}</dd></div>
      </dl>
      <div className="rounded border border-amber-900 p-2 text-xs text-amber-200">
        <p className="font-semibold">UNVERIFIED onBehalfOf claim</p>
        <p className="whitespace-pre-wrap break-words">{platform}: {claimedHuman}</p>
        {typeof claim.selfDescription === 'string' && <p className="whitespace-pre-wrap break-words">{claim.selfDescription}</p>}
      </div>
      {approval.decision?.mode && (
        <output className="block text-xs text-green-300">Signed action: {approval.decision.mode}</output>
      )}
      {typeof threadDid === 'string' && /^did:imajin:dm:[a-f0-9]{16}$/.test(threadDid) && (
        <a className="inline-flex min-h-11 items-center text-sm text-amber-300 underline"
          href={`/chat/conversations/dm/${threadDid.slice('did:imajin:dm:'.length)}`}>Open accepted thread</a>
      )}
    </div>
  );
}

const BUTTON = 'min-h-11 rounded px-3 py-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed';

/** Reply text is handed to the same controller that countersigns the selected mode. */
export function ReachApprovalActions({ approval, onDecide, busy }: Readonly<{
  approval: OperatorApprovalCard;
  onDecide: InboxDecisionHandler;
  busy: boolean;
}>) {
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <div className="space-y-3 pt-1">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => setComposing(true)}
          className={`${BUTTON} bg-amber-800 text-amber-100`}>Reply</button>
        <button type="button" disabled={busy} onClick={() => onDecide(approval, 'approve', 'accept')}
          className={`${BUTTON} bg-green-900 text-green-200`}>Accept thread</button>
        <button type="button" disabled={busy} onClick={() => onDecide(approval, 'approve', 'decline')}
          className={`${BUTTON} bg-gray-800 text-gray-200`}>Decline</button>
        <button type="button" disabled={busy} onClick={() => onDecide(approval, 'approve', 'block')}
          className={`${BUTTON} border border-red-900 text-red-300`}>Block</button>
      </div>
      {composing && (
        <div className="space-y-2">
          <label htmlFor={`inbox-reply-${approval.proposalId}`} className="block text-xs text-gray-400">
            Reply — signed with your own key. Does not create a thread.
          </label>
          <textarea id={`inbox-reply-${approval.proposalId}`} rows={3} maxLength={16000} value={message}
            disabled={busy} onChange={event => setMessage(event.target.value)}
            className="w-full rounded border border-gray-700 bg-gray-950 p-2 text-sm text-gray-100" />
          <button type="button" disabled={busy || !message.trim()}
            onClick={() => onDecide(approval, 'approve', 'reply', message)}
            className={`${BUTTON} bg-amber-800 text-amber-100`}>{busy ? 'Signing…' : 'Sign & send reply'}</button>
        </div>
      )}
      <p className="text-xs text-gray-500">Only Accept thread creates a chat. Block stops future requests from this sender.</p>
    </div>
  );
}
