'use client';

import { useState, useCallback } from 'react';

interface ResolvedIdentity {
  did: string;
  handle: string;
  displayName: string | null;
}

export default function DepositForm() {
  const [amount, setAmount] = useState('');
  const [handle, setHandle] = useState('');
  const [memo, setMemo] = useState('');
  const [resolved, setResolved] = useState<ResolvedIdentity | null>(null);
  const [resolving, setResolving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const resolveHandle = useCallback(async () => {
    const input = handle.trim();
    if (!input) return;

    setResolving(true);
    setError('');
    setResolved(null);

    try {
      // If it looks like a DID, skip resolution
      if (input.startsWith('did:')) {
        setResolved({ did: input, handle: '', displayName: null });
        return;
      }

      const res = await fetch(
        `/api/admin/deposits/resolve?handle=${encodeURIComponent(input)}`
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Handle not found');
        return;
      }

      const data: ResolvedIdentity = await res.json();
      setResolved(data);
    } catch {
      setError('Failed to resolve handle');
    } finally {
      setResolving(false);
    }
  }, [handle]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!resolved?.did) {
        setError('Resolve a handle or enter a DID first');
        return;
      }

      const numAmount = parseFloat(amount);
      if (!numAmount || numAmount <= 0) {
        setError('Amount must be a positive number');
        return;
      }

      setSubmitting(true);
      setError('');
      setSuccess('');

      try {
        const res = await fetch('/api/admin/deposits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            did: resolved.did,
            amount: numAmount,
            currency: 'CAD',
            memo: memo.trim(),
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Deposit failed');
          return;
        }

        setSuccess(
          `Deposited $${numAmount.toFixed(2)} CAD → ${resolved.handle || resolved.did.slice(0, 20)}… (tx: ${data.transactionId})`
        );
        setAmount('');
        setHandle('');
        setMemo('');
        setResolved(null);
      } catch {
        setError('Network error');
      } finally {
        setSubmitting(false);
      }
    },
    [resolved, amount, memo]
  );

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-5 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6"
    >
      {/* Handle / DID */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Target Handle or DID
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={handle}
            onChange={(e) => {
              setHandle(e.target.value);
              setResolved(null);
              setError('');
            }}
            placeholder="@handle or did:imajin:..."
            className="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
          <button
            type="button"
            onClick={resolveHandle}
            disabled={resolving || !handle.trim()}
            className="px-4 py-2 text-sm font-medium rounded-md bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {resolving ? 'Resolving…' : 'Resolve'}
          </button>
        </div>
        {resolved && (
          <div className="mt-2 text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 rounded px-3 py-2">
            ✓ {resolved.displayName || resolved.handle || 'Unknown'}{' '}
            <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
              ({resolved.did.slice(0, 20)}…{resolved.did.slice(-6)})
            </span>
          </div>
        )}
      </div>

      {/* Amount */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Amount (CAD)
        </label>
        <input
          type="number"
          step="0.01"
          min="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          className="w-48 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-orange-500 font-mono"
        />
      </div>

      {/* Memo */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Memo
        </label>
        <input
          type="text"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="e.g. EMT received May 12"
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-orange-500"
        />
      </div>

      {/* Error / Success */}
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded px-3 py-2">
          {error}
        </p>
      )}
      {success && (
        <p className="text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 rounded px-3 py-2">
          {success}
        </p>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={submitting || !resolved?.did || !amount}
        className="px-5 py-2 text-sm font-medium rounded-md bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? 'Processing…' : 'Record Deposit'}
      </button>
    </form>
  );
}
