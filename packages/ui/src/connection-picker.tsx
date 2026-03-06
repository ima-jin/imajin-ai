'use client';

import { useState, useEffect } from 'react';

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
}

export function ConnectionPicker({
  connectionsUrl,
  excludeDids = [],
  onSelect,
  placeholder = 'Search connections...',
  disabled = false,
}: ConnectionPickerProps) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch(connectionsUrl)
      .then(r => r.json())
      .then(data => {
        setConnections(data.connections || []);
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to load connections');
        setLoading(false);
      });
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
        disabled={disabled || loading}
        className="w-full px-3 py-2 text-sm border border-gray-600 rounded-lg bg-gray-900 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-50"
      />
      {loading ? (
        <p className="text-sm text-gray-500 px-1">Loading connections...</p>
      ) : error ? (
        <p className="text-sm text-red-400 px-1">{error}</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-500 px-1">
          {available.length === 0 ? 'No connections available.' : 'No matching connections.'}
        </p>
      ) : (
        <div className="space-y-0 max-h-48 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900">
          {filtered.map(conn => (
            <button
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
      )}
    </div>
  );
}
