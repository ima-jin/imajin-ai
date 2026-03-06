'use client';

import { useState, useEffect } from 'react';

interface Cohost {
  did: string;
  name: string | null;
  handle: string | null;
  avatar: string | null;
  role: string;
  addedAt: string;
}

interface CohostManagerProps {
  eventId: string;
  isOwner: boolean;
}

export function CohostManager({ eventId, isOwner }: CohostManagerProps) {
  const [cohosts, setCohosts] = useState<Cohost[]>([]);
  const [loading, setLoading] = useState(true);
  const [handle, setHandle] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/events/${eventId}/cohosts`)
      .then(r => r.json())
      .then(data => {
        setCohosts(data.cohosts || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [eventId]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!handle.trim()) return;

    setAdding(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch(`/api/events/${eventId}/cohosts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: handle.trim().replace(/^@/, '') }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to add cohost');
        return;
      }

      setCohosts(prev => [...prev, data.cohost]);
      setHandle('');
      setSuccess(`@${data.cohost.handle || data.cohost.did.slice(0, 12)} added as co-host`);
      setTimeout(() => setSuccess(null), 4000);
    } catch {
      setError('Failed to add cohost');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow">
      <h2 className="text-xl font-semibold mb-4">Co-hosts</h2>

      {loading ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : cohosts.length === 0 ? (
        <p className="text-gray-500 text-sm mb-4">No co-hosts added yet.</p>
      ) : (
        <ul className="space-y-3 mb-6">
          {cohosts.map(cohost => (
            <li key={cohost.did} className="flex items-center gap-3">
              {cohost.avatar ? (
                <img
                  src={cohost.avatar}
                  alt={cohost.name || cohost.handle || cohost.did}
                  className="w-9 h-9 rounded-full object-cover flex-shrink-0"
                />
              ) : (
                <div className="w-9 h-9 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center flex-shrink-0 text-sm font-semibold text-gray-500">
                  {(cohost.name || cohost.handle || cohost.did).charAt(0).toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                {cohost.name && (
                  <p className="text-sm font-medium truncate">{cohost.name}</p>
                )}
                {cohost.handle && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">@{cohost.handle}</p>
                )}
                {!cohost.name && !cohost.handle && (
                  <p className="text-xs text-gray-500 truncate font-mono">{cohost.did}</p>
                )}
              </div>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 flex-shrink-0">
                Co-host
              </span>
            </li>
          ))}
        </ul>
      )}

      {isOwner && (
        <form onSubmit={handleAdd} className="space-y-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={handle}
              onChange={e => setHandle(e.target.value)}
              placeholder="@handle"
              disabled={adding}
              className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={adding || !handle.trim()}
              className="px-4 py-2 text-sm font-medium bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition disabled:opacity-50 flex-shrink-0"
            >
              {adding ? 'Adding...' : 'Add Co-host'}
            </button>
          </div>
          {error && (
            <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
          )}
          {success && (
            <p className="text-sm text-green-500 dark:text-green-400">{success}</p>
          )}
        </form>
      )}
    </div>
  );
}
