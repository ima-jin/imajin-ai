'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function CreateFlag() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [targetDid, setTargetDid] = useState('');
  const [targetType, setTargetType] = useState('identity');
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await fetch('/api/admin/moderation/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDid, targetType, targetId, reason }),
      });
      setOpen(false);
      setTargetDid('');
      setTargetId('');
      setReason('');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 text-sm font-medium"
      >
        + Create Flag
      </button>
    );
  }

  return (
    <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-6">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Create Manual Flag</h3>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Target DID</label>
          <input
            required
            type="text"
            value={targetDid}
            onChange={(e) => setTargetDid(e.target.value)}
            placeholder="did:imajin:..."
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Target Type</label>
            <select
              value={targetType}
              onChange={(e) => setTargetType(e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            >
              <option value="identity">Identity</option>
              <option value="asset">Asset</option>
              <option value="listing">Listing</option>
              <option value="event">Event</option>
              <option value="message">Message</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Target ID</label>
            <input
              required
              type="text"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder="ID of flagged content"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Reason</label>
          <textarea
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Reason for flagging"
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium"
          >
            {submitting ? 'Submitting…' : 'Submit Flag'}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
