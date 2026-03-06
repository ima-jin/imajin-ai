'use client';

import { useState, useEffect, useCallback } from 'react';

interface Invite {
  id: string;
  eventId: string;
  token: string;
  label: string | null;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string | null;
  url: string;
}

interface Props {
  eventId: string;
  accessMode: string;
}

export function InviteManager({ eventId, accessMode }: Props) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // New invite form state
  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [formError, setFormError] = useState('');

  const fetchInvites = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/invites`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setInvites(data.invites || []);
      }
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchInvites();
  }, [fetchInvites]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setFormError('');

    try {
      const res = await fetch(`/api/events/${eventId}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          label: label || undefined,
          maxUses: maxUses ? parseInt(maxUses) : undefined,
          expiresAt: expiresAt || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create invite');
      }

      const data = await res.json();
      setInvites(prev => [data.invite, ...prev]);
      setLabel('');
      setMaxUses('');
      setExpiresAt('');
      setShowForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create invite');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(inviteId: string) {
    if (!confirm('Revoke this invite link? Anyone with this link will no longer be able to use it.')) return;

    const res = await fetch(`/api/events/${eventId}/invites/${inviteId}`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (res.ok) {
      setInvites(prev => prev.filter(inv => inv.id !== inviteId));
    }
  }

  function handleCopy(url: string, inviteId: string) {
    navigator.clipboard.writeText(url);
    setCopied(inviteId);
    setTimeout(() => setCopied(null), 2000);
  }

  const isInviteOnly = accessMode === 'invite_only';

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-8">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold">Invite Links</h2>
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
            isInviteOnly
              ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300'
              : 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
          }`}>
            {isInviteOnly ? 'Invite Only' : 'Public'}
          </span>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold rounded-lg transition"
        >
          + Generate Invite Link
        </button>
      </div>

      {isInviteOnly && (
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          This event is invite-only. Only people with a valid invite link can purchase tickets.
        </p>
      )}

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleCreate} className="mb-6 p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg space-y-3">
          <h3 className="font-medium text-sm">New Invite Link</h3>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              Label (optional)
            </label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. VIP batch, For Sarah"
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Max Uses (optional)
              </label>
              <input
                type="number"
                min="1"
                value={maxUses}
                onChange={e => setMaxUses(e.target.value)}
                placeholder="Unlimited"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Expires At (optional)
              </label>
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={e => setExpiresAt(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
              />
            </div>
          </div>
          {formError && (
            <p className="text-xs text-red-500">{formError}</p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="flex-1 py-2 text-sm bg-gray-200 hover:bg-gray-300 dark:bg-gray-600 dark:hover:bg-gray-500 text-gray-700 dark:text-gray-200 font-medium rounded-lg transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className="flex-1 py-2 text-sm bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white font-medium rounded-lg transition"
            >
              {creating ? 'Creating...' : 'Create Link'}
            </button>
          </div>
        </form>
      )}

      {/* Invite list */}
      {loading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-4">Loading...</p>
      ) : invites.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-4">
          No invite links yet. Generate one above.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider border-b border-gray-200 dark:border-gray-700">
                <th className="pb-2 pr-4">Link / Label</th>
                <th className="pb-2 pr-4">Uses</th>
                <th className="pb-2 pr-4">Expires</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {invites.map(invite => {
                const expired = invite.expiresAt && new Date(invite.expiresAt) < new Date();
                const exhausted = invite.maxUses !== null && invite.usedCount >= invite.maxUses;

                return (
                  <tr key={invite.id} className={expired || exhausted ? 'opacity-50' : ''}>
                    <td className="py-3 pr-4">
                      <div className="font-mono text-xs text-gray-600 dark:text-gray-400 truncate max-w-[200px]" title={invite.url}>
                        ...{invite.token.slice(-8)}
                      </div>
                      {invite.label && (
                        <div className="text-xs text-gray-500 mt-0.5">{invite.label}</div>
                      )}
                      {expired && <span className="text-xs text-red-500">Expired</span>}
                      {exhausted && <span className="text-xs text-orange-500">Exhausted</span>}
                    </td>
                    <td className="py-3 pr-4 text-gray-600 dark:text-gray-400">
                      {invite.usedCount} / {invite.maxUses ?? '∞'}
                    </td>
                    <td className="py-3 pr-4 text-gray-600 dark:text-gray-400">
                      {invite.expiresAt
                        ? new Date(invite.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                        : 'Never'}
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleCopy(invite.url, invite.id)}
                          className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded transition"
                          title="Copy link"
                        >
                          {copied === invite.id ? 'Copied!' : 'Copy'}
                        </button>
                        <button
                          onClick={() => handleDelete(invite.id)}
                          className="px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition"
                          title="Revoke"
                        >
                          Revoke
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
