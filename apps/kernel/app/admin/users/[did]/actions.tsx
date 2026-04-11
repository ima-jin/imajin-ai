'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface UserActionsProps {
  did: string;
  currentTier: string;
  isSuspended: boolean;
}

export default function UserActions({ did, currentTier, isSuspended }: UserActionsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const encodedDid = encodeURIComponent(did);

  async function handleSuspend() {
    const action = isSuspended ? 'unsuspend' : 'suspend';
    const confirmed = window.confirm(
      isSuspended
        ? 'Unsuspend this user? They will regain access.'
        : 'Suspend this user? They will lose access immediately.'
    );
    if (!confirmed) return;

    setLoading('suspend');
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${encodedDid}/suspend`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Failed to ${action}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(null);
    }
  }

  async function handleUpgradeTier(tier: 'preliminary' | 'established') {
    const confirmed = window.confirm(`Upgrade tier to "${tier}"? This will emit a verification attestation.`);
    if (!confirmed) return;

    setLoading('tier');
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${encodedDid}/upgrade-tier`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to upgrade tier');
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(null);
    }
  }

  const upgradableToTiers: Array<'preliminary' | 'established'> = [];
  if (currentTier === 'soft') upgradableToTiers.push('preliminary');
  if (currentTier === 'soft' || currentTier === 'preliminary') upgradableToTiers.push('established');

  return (
    <div className="flex flex-col items-end gap-2 shrink-0">
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400 max-w-48 text-right">{error}</p>
      )}

      <div className="flex gap-2 flex-wrap justify-end">
        {upgradableToTiers.map((tier) => (
          <button
            key={tier}
            onClick={() => handleUpgradeTier(tier)}
            disabled={loading !== null}
            className="rounded-lg border border-orange-500 text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20 px-3 py-1.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading === 'tier' ? 'Upgrading…' : `→ ${tier}`}
          </button>
        ))}

        <button
          onClick={handleSuspend}
          disabled={loading !== null}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
            isSuspended
              ? 'border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
              : 'bg-red-600 hover:bg-red-700 text-white border border-transparent'
          }`}
        >
          {loading === 'suspend'
            ? isSuspended
              ? 'Unsuspending…'
              : 'Suspending…'
            : isSuspended
            ? 'Unsuspend'
            : 'Suspend'}
        </button>
      </div>
    </div>
  );
}
