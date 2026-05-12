'use client';

import { useState } from 'react';

interface ResolvedTarget {
  did: string;
  displayName: string | null;
  handle: string | null;
}

interface SubmitResult {
  success: boolean;
  transactionId?: string;
  amount?: number;
  error?: string;
}

export default function DepositMatchForm() {
  const [amount, setAmount] = useState('');
  const [currency] = useState('CAD');
  const [target, setTarget] = useState('');
  const [resolved, setResolved] = useState<ResolvedTarget | null>(null);
  const [resolving, setResolving] = useState(false);
  const [memo, setMemo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [error, setError] = useState('');

  async function resolveTarget() {
    const trimmed = target.trim();
    if (!trimmed) {
      setResolved(null);
      return;
    }

    // If it looks like a DID, accept it directly
    if (trimmed.startsWith('did:')) {
      setResolved({ did: trimmed, displayName: null, handle: null });
      return;
    }

    setResolving(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/deposits/resolve?handle=${encodeURIComponent(trimmed)}`);
      const data = await res.json();
      if (!res.ok) {
        setResolved(null);
        setError(data.error ?? 'Could not resolve handle');
        return;
      }
      setResolved(data);
    } catch (e) {
      setResolved(null);
      setError('Network error resolving handle');
    } finally {
      setResolving(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setResult(null);

    if (!resolved) {
      setError('Please resolve a valid target DID or handle first');
      return;
    }

    const numAmount = parseFloat(amount);
    if (!amount || isNaN(numAmount) || numAmount <= 0) {
      setError('Please enter a valid amount greater than 0');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/deposits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          did: resolved.did,
          amount: numAmount,
          currency,
          memo: memo.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Deposit failed');
        return;
      }
      setResult({ success: true, transactionId: data.transactionId, amount: numAmount });
      // Reset form
      setAmount('');
      setTarget('');
      setResolved(null);
      setMemo('');
    } catch (e) {
      setError('Network error submitting deposit');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Credit Deposit</h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Amount */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Amount <span className="text-gray-400">(CAD)</span>
          </label>
          <div className="flex items-center gap-2">
            <span className="text-gray-500 dark:text-gray-400 text-sm">$</span>
            <input
              type="number"
              step="0.01"
              min="0.01"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="50.00"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <input
              type="text"
              value={currency}
              readOnly
              className="w-20 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-400 px-3 py-2 text-sm cursor-not-allowed"
            />
          </div>
        </div>

        {/* Target */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Target DID or Handle
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              required
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setResolved(null);
                setError('');
              }}
              onBlur={resolveTarget}
              placeholder="@username or did:imajin:..."
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <button
              type="button"
              onClick={resolveTarget}
              disabled={resolving || !target.trim()}
              className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {resolving ? '…' : 'Lookup'}
            </button>
          </div>

          {resolved && (
            <div className="mt-2 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-3 py-2">
              <p className="text-sm text-green-800 dark:text-green-300">
                {resolved.displayName ? (
                  <>
                    <span className="font-medium">{resolved.displayName}</span>
                    {resolved.handle && <span className="text-green-600 dark:text-green-400"> @{resolved.handle}</span>}
                  </>
                ) : (
                  <span className="font-medium">DID</span>
                )}
              </p>
              <p className="text-xs text-green-600 dark:text-green-400 font-mono mt-0.5 truncate">
                {resolved.did}
              </p>
            </div>
          )}
        </div>

        {/* Memo */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Memo / Reference <span className="text-gray-400">(optional)</span>
          </label>
          <input
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="e.g. EMT from RBC, May 12"
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Used to match against bank email notifications
          </p>
        </div>

        {/* Feedback */}
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {result?.success && (
          <div className="rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-4 py-3">
            <p className="text-sm text-green-800 dark:text-green-300 font-medium">
              Credited ${result.amount?.toFixed(2)} CAD
            </p>
            <p className="text-xs text-green-600 dark:text-green-400 font-mono mt-0.5">
              Transaction: {result.transactionId}
            </p>
          </div>
        )}

        {/* Submit */}
        <div className="pt-2">
          <button
            type="submit"
            disabled={submitting || !resolved}
            className="rounded-lg bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Crediting…' : 'Credit Deposit'}
          </button>
        </div>
      </form>
    </div>
  );
}
