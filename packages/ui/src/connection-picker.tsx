'use client';

import { useState, useEffect, type ReactNode } from 'react';

interface Connection {
  did: string;
  name: string | null;
  handle: string | null;
  avatar: string | null;
}

export interface ConnectionPickerProps {
  connectionsUrl: string;
  excludeDids?: string[];
  onSelect: (connection: Connection) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Shown when the user has no connections at all (not when a search matches nothing). Defaults to "No connections available." */
  emptyMessage?: ReactNode;
}

const DEFAULT_EMPTY_MESSAGE = 'No connections available.';

/** A failed load, carrying a message that is safe to show the user as-is. */
class ConnectionsLoadError extends Error {}

function describeLoadFailure(status: number): string {
  if (status === 401) return 'Your session has expired. Sign in again to load connections.';
  if (status === 403) return "You don't have permission to view these connections.";
  return `Failed to load connections (HTTP ${status}).`;
}

/** Fetch the connection list, throwing a {@link ConnectionsLoadError} for any non-2xx response so it never reads as an empty list. */
async function fetchConnections(url: string): Promise<Connection[]> {
  const res = await fetch(url);
  if (!res.ok) throw new ConnectionsLoadError(describeLoadFailure(res.status));
  const data = await res.json();
  return data.connections ?? [];
}

export function ConnectionPicker({
  connectionsUrl,
  excludeDids = [],
  onSelect,
  placeholder = 'Search connections...',
  disabled = false,
  emptyMessage = DEFAULT_EMPTY_MESSAGE,
}: Readonly<ConnectionPickerProps>) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchConnections(connectionsUrl)
      .then(list => {
        if (!cancelled) setConnections(list);
      })
      .catch(err => {
        if (!cancelled) {
          setConnections([]);
          setError(err instanceof ConnectionsLoadError ? err.message : 'Failed to load connections');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionsUrl]);

  const excludeSet = new Set(excludeDids);
  const available = connections.filter(c => !excludeSet.has(c.did));
  const filtered = search
    ? available.filter(c =>
        (c.handle || '').toLowerCase().includes(search.toLowerCase()) ||
        (c.name || '').toLowerCase().includes(search.toLowerCase())
      )
    : available;

  return (
    <div className="space-y-2">
      <input
        type="text"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder={placeholder}
        disabled={disabled || loading || error !== null}
        className="w-full px-3 py-2 text-sm border border-gray-600 rounded-lg bg-gray-900 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-50"
      />
      {(() => {
        if (loading) return <p className="text-sm text-gray-500 px-1">Loading connections...</p>;
        if (error) return <p role="alert" className="text-sm text-red-400 px-1">{error}</p>;
        if (filtered.length === 0) return (
        <p className="text-sm text-gray-500 px-1">
          {available.length === 0 ? emptyMessage : 'No matching connections.'}
        </p>
        );
        return (
        <div className="space-y-0 max-h-48 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900">
          {filtered.map(conn => (
            <button type="button"
              key={conn.did}
              onClick={() => { onSelect(conn); setSearch(''); }}
              disabled={disabled}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-800 transition text-left disabled:opacity-50"
            >
              {conn.avatar ? (
                <img
                  src={conn.avatar}
                  alt={conn.name || conn.handle || conn.did}
                  className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center text-gray-400 text-sm font-semibold flex-shrink-0">
                  {(conn.name || conn.handle || conn.did).charAt(0).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <div className="text-sm font-medium text-white truncate">
                  {conn.name || (conn.handle ? `@${conn.handle}` : conn.did.slice(0, 20) + '...')}
                </div>
                {conn.handle && conn.name && (
                  <div className="text-xs text-gray-400 truncate">@{conn.handle}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      );
      })()}
    </div>
  );
}
