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

  async function handleUpgradeTier(tier: 'preliminary' | 'established' | 'steward' | 'operator') {
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

  const allTiers = ['soft', 'preliminary', 'established', 'steward', 'operator'] as const;
  const currentIdx = allTiers.indexOf(currentTier as any);
  const upgradableToTiers = allTiers.slice(Math.max(currentIdx + 1, 1)) as unknown as Array<'preliminary' | 'established' | 'steward' | 'operator'>;

  return (
    <div className="flex flex-col items-end gap-2 shrink-0">
      {error && (
        <p className="text-xs text-error dark:text-error max-w-48 text-right">{error}</p>
      )}

      <div className="flex gap-2 flex-wrap justify-end">
        {upgradableToTiers.map((tier) => (
          <button
            key={tier}
            onClick={() => handleUpgradeTier(tier)}
            disabled={loading !== null}
            className="border border-imajin-orange text-imajin-orange dark:text-imajin-orange hover:bg-imajin-orange/10 dark:hover:bg-imajin-orange/20 px-3 py-1.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading === 'tier' ? 'Upgrading…' : `→ ${tier}`}
          </button>
        ))}

        <button
          onClick={handleSuspend}
          disabled={loading !== null}
          className={`px-3 py-1.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
            isSuspended
              ? 'border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated'
              : 'bg-error hover:bg-error text-primary border border-transparent'
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
