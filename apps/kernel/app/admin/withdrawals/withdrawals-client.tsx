'use client';

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';

interface Withdrawal {
  id: string;
  did: string;
  amount: string;
  currency: string;
  emtEmail: string;
  status: string;
  adminNotes: string | null;
  requestedAt: string | Date;
  processedAt: string | Date | null;
}

interface Props {
  pendingWithdrawals: Withdrawal[];
  completedWithdrawals: Withdrawal[];
}

function truncateDid(did: string) {
  if (did.length <= 24) return did;
  return `${did.slice(0, 12)}…${did.slice(-8)}`;
}

function formatCurrency(amount: string, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(parseFloat(amount));
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    requested: 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400',
    processing: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
    sent: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400',
    cancelled: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-medium ${styles[status] ?? styles.requested}`}>
      {status}
    </span>
  );
}

function WithdrawalRow({
  w,
  onMarkSent,
  isCompleted,
}: {
  w: Withdrawal;
  onMarkSent?: (id: string, notes: string) => void;
  isCompleted?: boolean;
}) {
  const [notes, setNotes] = useState('');
  const [marking, setMarking] = useState(false);

  const requestedAt = w.requestedAt ? new Date(w.requestedAt) : null;
  const processedAt = w.processedAt ? new Date(w.processedAt) : null;

  return (
    <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors">
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-gray-600 dark:text-gray-400" title={w.did}>
          {truncateDid(w.did)}
        </span>
      </td>
      <td className="px-4 py-3 text-gray-900 dark:text-white font-medium">
        {formatCurrency(w.amount, w.currency)}
      </td>
      <td className="px-4 py-3 text-gray-600 dark:text-gray-400 text-sm">
        {w.emtEmail}
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={w.status} />
      </td>
      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
        {requestedAt ? formatDistanceToNow(requestedAt, { addSuffix: true }) : '—'}
      </td>
      <td className="px-4 py-3">
        {isCompleted ? (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {processedAt ? formatDistanceToNow(processedAt, { addSuffix: true }) : '—'}
          </span>
        ) : onMarkSent ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Admin notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-40 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-orange-500"
            />
            <button
              onClick={async () => {
                setMarking(true);
                await onMarkSent(w.id, notes);
                setMarking(false);
              }}
              disabled={marking}
              className="rounded bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white px-2.5 py-1 text-xs font-medium transition-colors"
            >
              {marking ? '…' : 'Mark Sent'}
            </button>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

export default function WithdrawalsClient({ pendingWithdrawals, completedWithdrawals }: Props) {
  const [pending, setPending] = useState(pendingWithdrawals);
  const [completed, setCompleted] = useState(completedWithdrawals);
  const [error, setError] = useState('');

  async function handleMarkSent(id: string, notes: string) {
    setError('');
    try {
      const res = await fetch(`/api/admin/withdrawals/${id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_notes: notes || undefined }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      // Move from pending to completed
      const moved = pending.find((w) => w.id === id);
      if (moved) {
        setPending((prev) => prev.filter((w) => w.id !== id));
        setCompleted((prev) => [
          { ...moved, status: 'sent', processedAt: new Date().toISOString() },
          ...prev,
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark as sent');
    }
  }

  return (
    <div>
      {error && (
        <div className="mb-4 rounded-lg bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 px-4 py-2 text-sm">
          {error}
        </div>
      )}

      {/* Pending */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Pending ({pending.length})
        </h2>
        <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 overflow-hidden">
          {pending.length === 0 ? (
            <p className="px-6 py-8 text-sm text-gray-400 dark:text-gray-500 text-center">
              No pending withdrawal requests
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">DID</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Amount</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">EMT Email</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Status</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Requested</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {pending.map((w) => (
                    <WithdrawalRow key={w.id} w={w} onMarkSent={handleMarkSent} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Completed */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Completed ({completed.length})
        </h2>
        <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 overflow-hidden">
          {completed.length === 0 ? (
            <p className="px-6 py-8 text-sm text-gray-400 dark:text-gray-500 text-center">
              No completed withdrawals yet
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">DID</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Amount</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">EMT Email</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Status</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Requested</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Processed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {completed.map((w) => (
                    <WithdrawalRow key={w.id} w={w} isCompleted />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
