'use client';

import { useState } from 'react';

export default function AdminWithdrawalsGatingPage() {
  const [did, setDid] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setResult(null);

    try {
      const res = await fetch('/api/admin/withdrawals/gating', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did, enabled }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        setResult({ success: true, message: `Withdrawals ${enabled ? 'enabled' : 'disabled'} for ${did}` });
        setDid('');
      } else {
        setResult({ success: false, message: data.error || `Failed (${res.status})` });
      }
    } catch (err) {
      setResult({ success: false, message: err instanceof Error ? err.message : 'Request failed' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 lg:p-8 max-w-xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Withdrawal Gating</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Enable or disable EMT withdrawals per DID
        </p>
      </div>

      {result && (
        <div
          className={`mb-4 rounded-lg px-4 py-3 text-sm ${
            result.success
              ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
              : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
          }`}
        >
          {result.message}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            DID
          </label>
          <input
            type="text"
            value={did}
            onChange={(e) => setDid(e.target.value)}
            placeholder="did:imajin:..."
            required
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 font-mono"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setEnabled(true)}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium border transition-colors ${
              enabled
                ? 'bg-green-600 border-green-600 text-white'
                : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
            }`}
          >
            ✅ Enable
          </button>
          <button
            type="button"
            onClick={() => setEnabled(false)}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium border transition-colors ${
              !enabled
                ? 'bg-red-600 border-red-600 text-white'
                : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
            }`}
          >
            🚫 Disable
          </button>
        </div>

        <button
          type="submit"
          disabled={loading || !did}
          className="w-full rounded-lg bg-orange-500 hover:bg-orange-600 disabled:bg-gray-400 text-white px-4 py-2 text-sm font-medium transition-colors"
        >
          {loading ? 'Updating…' : 'Update'}
        </button>
      </form>
    </div>
  );
}
