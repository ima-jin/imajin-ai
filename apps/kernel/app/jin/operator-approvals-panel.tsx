'use client';

/**
 * Operator approvals panel for the `/jin` kernel dashboard (#2059).
 *
 * Renders pending `operator.approval.requested` proposals (gateway restart /
 * config mutation) as a confirm card, mirroring the proposals table in
 * page.tsx and the polling/silent-refresh conventions of
 * usage-feed-panel.tsx. Tapping Approve/Deny signs and publishes an
 * `operator.approval.decided` event through `POST /jin/api/operator-
 * approvals/:proposalId/decision` — the kernel is the one that signs, this
 * component only makes the authenticated tap.
 *
 * Renders NOTHING (not even a header) when the signed-in identity is not
 * the node operator — `GET /jin/api/operator-approvals` reports
 * `isOperator: false` with an empty list for anyone else, and this panel
 * takes that at face value rather than trying to distinguish "no data" from
 * "not allowed".
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 5000;

type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'withdrawn' | 'applied';
type ApprovalKind = 'restart' | 'config-mutation' | 'other';
type DecisionAction = 'approve' | 'deny' | 'withdrawn';

interface OperatorApprovalCard {
  proposalId: string;
  kind: ApprovalKind;
  summary: string;
  keysTouched: string[];
  status: ApprovalStatus;
  decision: { decidedBy: string; decidedAt: string; reason?: string } | null;
  appliedAt: string | null;
  createdAt: string;
}

function statusBadge(status: ApprovalStatus) {
  const styles: Record<ApprovalStatus, string> = {
    pending: 'bg-yellow-900/60 text-yellow-300',
    approved: 'bg-green-900/60 text-green-300',
    applied: 'bg-blue-900/60 text-blue-300',
    denied: 'bg-red-900/60 text-red-400',
    withdrawn: 'bg-gray-800 text-gray-500',
  };
  const labels: Record<ApprovalStatus, string> = {
    pending: 'pending',
    approved: 'approved — pending apply',
    applied: 'applied',
    denied: 'denied',
    withdrawn: 'withdrawn',
  };
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${styles[status]}`}>{labels[status]}</span>;
}

function KeysTouched({ keys }: Readonly<{ keys: string[] }>) {
  if (keys.length === 0) return <span className="text-gray-600">—</span>;
  return (
    <span className="font-mono text-xs text-gray-400">
      {keys.join(', ')}
    </span>
  );
}

function ApprovalCardRow({
  approval,
  onDecide,
  busy,
}: Readonly<{
  approval: OperatorApprovalCard;
  onDecide: (proposalId: string, decision: DecisionAction) => void;
  busy: boolean;
}>) {
  return (
    <div className="rounded-lg border border-gray-800 p-4 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {statusBadge(approval.status)}
          <span className="px-1.5 py-0.5 rounded text-xs font-mono bg-orange-900/50 text-orange-300">
            {approval.kind}
          </span>
        </div>
        <span className="text-xs text-gray-500">{new Date(approval.createdAt).toLocaleString()}</span>
      </div>
      <p className="text-sm text-gray-200">{approval.summary}</p>
      <div className="text-xs text-gray-500">
        <span className="uppercase tracking-wide mr-2">Keys touched</span>
        <KeysTouched keys={approval.keysTouched} />
      </div>
      {approval.status === 'pending' && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => onDecide(approval.proposalId, 'deny')}
            disabled={busy}
            className="px-3 py-1.5 rounded text-xs font-medium bg-red-900/40 text-red-300 hover:bg-red-800/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => onDecide(approval.proposalId, 'approve')}
            disabled={busy}
            autoFocus
            className="px-3 py-1.5 rounded text-xs font-medium bg-green-700/70 text-green-100 hover:bg-green-600/70 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ring-1 ring-green-500/50"
          >
            {busy ? '…' : 'Approve'}
          </button>
        </div>
      )}
      {approval.status === 'approved' && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => onDecide(approval.proposalId, 'withdrawn')}
            disabled={busy}
            className="px-3 py-1.5 rounded text-xs font-medium bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? '…' : 'Withdraw'}
          </button>
        </div>
      )}
    </div>
  );
}

// S3358: avoid nested ternary by extracting render logic.
function renderPanelBody(
  loading: boolean,
  approvals: OperatorApprovalCard[],
  onDecide: (proposalId: string, decision: DecisionAction) => void,
  busyId: string,
) {
  if (loading) {
    return <p className="text-sm text-gray-500 py-6 text-center">Loading…</p>;
  }
  if (approvals.length === 0) {
    return (
      <div className="text-center py-10 rounded-lg border border-gray-800">
        <p className="text-gray-500 text-sm">No operator approvals yet.</p>
        <p className="text-gray-700 text-xs mt-1">
          Gateway restart and config proposals from OpenClaw appear here.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {approvals.map((approval) => (
        <ApprovalCardRow
          key={approval.proposalId}
          approval={approval}
          onDecide={onDecide}
          busy={busyId === approval.proposalId}
        />
      ))}
    </div>
  );
}

export function OperatorApprovalsPanel() {
  const [isOperator, setIsOperator] = useState(false);
  const [approvals, setApprovals] = useState<OperatorApprovalCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [flash, setFlash] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const notify = useCallback((type: 'ok' | 'err', msg: string) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/jin/api/operator-approvals', { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as { isOperator: boolean; approvals: OperatorApprovalCard[] };
      setIsOperator(data.isOperator);
      setApprovals(data.approvals ?? []);
    } catch {
      // Silent — this panel simply stays empty on a transient network error.
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    pollRef.current = setInterval(() => load(true), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  const handleDecide = useCallback(async (proposalId: string, decision: DecisionAction) => {
    setBusyId(proposalId);
    try {
      const res = await fetch(`/jin/api/operator-approvals/${encodeURIComponent(proposalId)}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        notify('err', body.error ?? `Decision failed (${res.status})`);
        return;
      }
      notify('ok', `Proposal ${decision}.`);
      await load(true);
    } finally {
      setBusyId('');
    }
  }, [load, notify]);

  // Non-operators see nothing — no header, no empty-state, no card. This
  // also holds during the initial load so nobody briefly sees panel chrome
  // before the operator check resolves.
  if (!isOperator) return null;

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-gray-100">Operator approvals</h2>
          <p className="text-xs text-gray-500">Gateway restart / config proposals — approve from anywhere</p>
        </div>
        <button
          type="button"
          onClick={() => load()}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          ↺ refresh
        </button>
      </div>

      {flash && (
        <div className={`mb-3 px-3 py-2 rounded text-xs font-medium ${
          flash.type === 'ok' ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'
        }`}>
          {flash.msg}
        </div>
      )}

      {renderPanelBody(loading, approvals, handleDecide, busyId)}
    </section>
  );
}
