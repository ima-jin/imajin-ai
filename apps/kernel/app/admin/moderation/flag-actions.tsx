'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface FlagActionsProps {
  flagId: string;
  targetDid: string;
}

export function FlagActions({ flagId, targetDid }: FlagActionsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [resolution, setResolution] = useState('');

  async function dismiss() {
    setLoading('dismiss');
    try {
      await fetch(`/api/admin/moderation/flags/${flagId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'dismissed', resolution: resolution || 'Dismissed by operator' }),
      });
      router.refresh();
    } finally {
      setLoading(null);
    }
  }

  async function suspendTarget() {
    setLoading('suspend');
    try {
      await fetch(`/api/admin/users/${encodeURIComponent(targetDid)}/suspend`, { method: 'POST' });
      await fetch(`/api/admin/moderation/flags/${flagId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'actioned', resolution: resolution || 'Target suspended' }),
      });
      router.refresh();
    } finally {
      setLoading(null);
    }
  }

  async function removeContent() {
    setLoading('remove');
    try {
      await fetch(`/api/admin/moderation/flags/${flagId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'actioned', resolution: resolution || 'Content removal logged' }),
      });
      router.refresh();
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <input
        type="text"
        value={resolution}
        onChange={(e) => setResolution(e.target.value)}
        placeholder="Resolution note (optional)"
        className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500"
      />
      <div className="flex flex-wrap gap-2">
        <button
          onClick={dismiss}
          disabled={!!loading}
          className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          {loading === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
        </button>
        <button
          onClick={suspendTarget}
          disabled={!!loading}
          className="rounded-lg bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white px-3 py-1.5 text-xs font-medium"
        >
          {loading === 'suspend' ? 'Suspending…' : 'Suspend Target'}
        </button>
        <button
          onClick={removeContent}
          disabled={!!loading}
          className="rounded-lg bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white px-3 py-1.5 text-xs font-medium"
        >
          {loading === 'remove' ? 'Logging…' : 'Remove Content'}
        </button>
      </div>
    </div>
  );
}
