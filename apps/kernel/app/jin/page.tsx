'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Proposal {
  id: string;
  ownerDid: string;
  agentDid: string | null;
  scope: string;
  tool: string;
  riskTier: string;
  target: string;
  argsSummary: string;
  status: 'pending' | 'approved' | 'done' | 'denied';
  approvedUntil: string | null;  // ISO string or null
  createdAt: string;
}

// ─── TTL countdown ────────────────────────────────────────────────────────────

function useTtlCountdown(approvedUntil: string | null): string | null {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!approvedUntil) { setLabel(null); return; }

    function tick() {
      const remaining = new Date(approvedUntil!).getTime() - Date.now();
      if (remaining <= 0) {
        setLabel('expired');
        return;
      }
      const secs = Math.floor(remaining / 1000);
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      // S3358: avoid nested ternary
      let timeLabel: string;
      if (h > 0) { timeLabel = `${h}h ${m}m`; }
      else if (m > 0) { timeLabel = `${m}m ${s}s`; }
      else { timeLabel = `${s}s`; }
      setLabel(timeLabel);
    }

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [approvedUntil]);

  return label;
}

// ─── Single proposal row ──────────────────────────────────────────────────────

function ProposalRow({
  proposal,
  onAction,
  actionLoading,
}: Readonly<{
  proposal: Proposal;
  onAction: (id: string, action: 'deny' | 'single' | '5m' | '24h') => void;
  actionLoading: string;
}>) {
  const ttl = useTtlCountdown(proposal.approvedUntil);
  const busy = actionLoading === proposal.id;

  const statusBadge = () => {
    switch (proposal.status) {
      case 'pending':
        return <span className="px-2 py-0.5 rounded text-xs font-medium bg-yellow-900/60 text-yellow-300">pending</span>;
      case 'approved': {
        // S3358/S4624: avoid nested ternary and nested template literal
        const ttlSuffix = ttl ? ' \u00b7 ' + ttl : '';
        const approvedLabel = proposal.approvedUntil === null ? 'approved (single)' : 'approved' + ttlSuffix;
        return (
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-900/60 text-green-300">
            {approvedLabel}
          </span>
        );
      }
      case 'done':
        return <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-700 text-gray-400">done</span>;
      case 'denied':
        return <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-900/60 text-red-400">denied</span>;
    }
  };

  const riskBadge = (
    <span className={`px-1.5 py-0.5 rounded text-xs font-mono ${
      proposal.riskTier === 'mutate'
        ? 'bg-orange-900/50 text-orange-300'
        : 'bg-blue-900/50 text-blue-300'
    }`}>
      {proposal.riskTier}
    </span>
  );

  const canAct = proposal.status === 'pending' && !busy;

  return (
    <tr className="border-b border-gray-800 hover:bg-gray-900/40 transition-colors">
      {/* Status */}
      <td className="px-4 py-3 whitespace-nowrap">{statusBadge()}</td>

      {/* Risk */}
      <td className="px-4 py-3 whitespace-nowrap">{riskBadge}</td>

      {/* Tool */}
      <td className="px-4 py-3 font-mono text-xs text-gray-200 whitespace-nowrap">
        {proposal.tool}
      </td>

      {/* Target */}
      <td className="px-4 py-3 font-mono text-xs text-gray-400 max-w-[180px] truncate" title={proposal.target}>
        {proposal.target}
      </td>

      {/* Args summary */}
      <td className="px-4 py-3 text-xs text-gray-400 max-w-[240px] truncate" title={proposal.argsSummary}>
        {proposal.argsSummary}
      </td>

      {/* Agent */}
      <td className="px-4 py-3 font-mono text-xs text-gray-500 max-w-[120px] truncate" title={proposal.agentDid ?? undefined}>
        {proposal.agentDid ? proposal.agentDid.slice(-12) : '—'}
      </td>

      {/* Created */}
      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
        {new Date(proposal.createdAt).toLocaleTimeString()}
      </td>

      {/* Controls */}
      <td className="px-4 py-3 whitespace-nowrap">
        {proposal.status === 'pending' ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onAction(proposal.id, 'deny')}
              disabled={!canAct}
              className="px-2.5 py-1 rounded text-xs font-medium bg-red-900/40 text-red-300 hover:bg-red-800/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              No
            </button>
            <button
              type="button"
              onClick={() => onAction(proposal.id, 'single')}
              disabled={!canAct}
              autoFocus
              className="px-2.5 py-1 rounded text-xs font-medium bg-green-700/70 text-green-100 hover:bg-green-600/70 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ring-1 ring-green-500/50"
            >
              {busy ? '…' : 'Yes'}
            </button>
            <button
              type="button"
              onClick={() => onAction(proposal.id, '5m')}
              disabled={!canAct}
              className="px-2.5 py-1 rounded text-xs font-medium bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              5m
            </button>
            <button
              type="button"
              onClick={() => onAction(proposal.id, '24h')}
              disabled={!canAct}
              className="px-2.5 py-1 rounded text-xs font-medium bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              24h
            </button>
          </div>
        ) : (
          <span className="text-xs text-gray-600">—</span>
        )}
      </td>
    </tr>
  );
}

// ─── Body renderer (avoids nested ternary in JSX — S3358) ───────────────────

function renderBody(
  loading: boolean,
  visible: Proposal[],
  showDone: boolean,
  onAction: (id: string, action: 'deny' | 'single' | '5m' | '24h') => void,
  actionLoading: string,
) {
  if (loading) {
    return <p className="text-sm text-gray-500 py-8 text-center">Loading…</p>;
  }
  if (visible.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-gray-600 text-sm">No proposals{showDone ? '' : ' pending'}.</p>
        <p className="text-gray-700 text-xs mt-1">Proposals appear here when an agent tool call requires human approval.</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 border-b border-gray-800 bg-gray-900/50">
            <th className="px-4 py-2.5 text-left font-medium">Status</th>
            <th className="px-4 py-2.5 text-left font-medium">Risk</th>
            <th className="px-4 py-2.5 text-left font-medium">Tool</th>
            <th className="px-4 py-2.5 text-left font-medium">Target</th>
            <th className="px-4 py-2.5 text-left font-medium">Args</th>
            <th className="px-4 py-2.5 text-left font-medium">Agent</th>
            <th className="px-4 py-2.5 text-left font-medium">Time</th>
            <th className="px-4 py-2.5 text-left font-medium">Action</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((p) => (
            <ProposalRow
              key={p.id}
              proposal={p}
              onAction={onAction}
              actionLoading={actionLoading}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function JinPage() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const [flash, setFlash] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [showDone, setShowDone] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const notify = useCallback((type: 'ok' | 'err', msg: string) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const statuses = showDone ? 'pending,approved,done,denied' : 'pending,approved';
      const res = await fetch(`/github/api/proposals?status=${statuses}&limit=100`, {
        credentials: 'include',
      });
      if (res.status === 401) {
        globalThis.location.href = '/auth/login?next=/jin';
        return;
      }
      if (!res.ok) {
        notify('err', `Failed to load proposals (${res.status})`);
        return;
      }
      const data = await res.json() as { proposals: Proposal[] };
      setProposals(data.proposals ?? []);
    } catch {
      if (!silent) notify('err', 'Network error loading proposals');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [showDone]);

  // Initial load + start poll.
  useEffect(() => {
    load();
    pollRef.current = setInterval(() => load(true), 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  const handleAction = useCallback(async (id: string, action: 'deny' | 'single' | '5m' | '24h') => {
    setActionLoading(id);
    try {
      if (action === 'deny') {
        const res = await fetch(`/github/api/confirm/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          notify('err', body.error ?? `Deny failed (${res.status})`);
          return;
        }
        notify('ok', 'Proposal denied — tool call stays blocked.');
      } else {
        const ttl = action === 'single' ? 'single' : action;
        const res = await fetch(`/github/api/confirm/${encodeURIComponent(id)}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          notify('err', body.error ?? `Approve failed (${res.status})`);
          return;
        }
        const data = await res.json() as { message: string };
        notify('ok', data.message ?? 'Approved.');
      }
      await load(true);
    } finally {
      setActionLoading('');
    }
  }, [load, notify]);

  const pending  = proposals.filter((p) => p.status === 'pending');
  const approved = proposals.filter((p) => p.status === 'approved');
  const rest     = proposals.filter((p) => p.status === 'done' || p.status === 'denied');
  const visible  = [...pending, ...approved, ...(showDone ? rest : [])];

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold text-amber-500">人</span>
          <div>
            <h1 className="text-base font-semibold leading-tight">/jin</h1>
            <p className="text-xs text-gray-500">Pending proposals — human approval surface</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {pending.length > 0 && (
            <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-yellow-900/60 text-yellow-300 animate-pulse">
              {pending.length} pending
            </span>
          )}
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showDone}
              onChange={(e) => setShowDone(e.target.checked)}
              className="accent-amber-500"
            />
            <span>show done/denied</span>
          </label>
          <button
            type="button"
            onClick={() => load()}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            ↺ refresh
          </button>
        </div>
      </header>

      {/* Flash banner */}
      {flash && (
        <div className={`px-6 py-2 text-xs font-medium ${
          flash.type === 'ok' ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'
        }`}>
          {flash.msg}
        </div>
      )}

      {/* Body — S3358: avoid nested ternary by extracting render logic */}
      <main className="px-6 py-4">
        {renderBody(loading, visible, showDone, handleAction, actionLoading)}
      </main>
    </div>
  );
}
