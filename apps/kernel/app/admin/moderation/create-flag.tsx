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
        style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className=" hover:brightness-110 text-primary px-4 py-2 text-sm font-medium"
      >
        + Create Flag
      </button>
    );
  }

  return (
    <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-6">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-primary mb-4 font-mono">Create Manual Flag</h3>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="block text-xs text-secondary dark:text-secondary mb-1">Target DID</label>
          <input
            required
            type="text"
            value={targetDid}
            onChange={(e) => setTargetDid(e.target.value)}
            placeholder="did:imajin:..."
            className="w-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-secondary dark:text-secondary mb-1">Target Type</label>
            <select
              value={targetType}
              onChange={(e) => setTargetType(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple"
            >
              <option value="identity">Identity</option>
              <option value="asset">Asset</option>
              <option value="listing">Listing</option>
              <option value="event">Event</option>
              <option value="message">Message</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-secondary dark:text-secondary mb-1">Target ID</label>
            <input
              required
              type="text"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder="ID of flagged content"
              className="w-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs text-secondary dark:text-secondary mb-1">Reason</label>
          <textarea
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Reason for flagging"
            className="w-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-surface-elevated text-gray-900 dark:text-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-imajin-purple"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={submitting}
            style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className=" hover:brightness-110 disabled:opacity-50 text-primary px-4 py-2 text-sm font-medium"
          >
            {submitting ? 'Submitting…' : 'Submit Flag'}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
