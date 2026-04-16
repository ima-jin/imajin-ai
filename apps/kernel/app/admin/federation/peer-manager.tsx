'use client';

import { useState, useEffect, useCallback } from 'react';
import { formatDistanceToNow } from 'date-fns';

interface Peer {
  peer_url: string;
  push: number;
  fetch: number;
  sync: number;
  enabled: number;
  label: string | null;
  created_at: string;
  cursor: string | null;
  last_synced: string | null;
}

export default function PeerManager() {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newPeerUrl, setNewPeerUrl] = useState('');
  const [newPeerLabel, setNewPeerLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPeers = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/federation/peers');
      if (!res.ok) throw new Error('Failed to fetch peers');
      const data = await res.json();
      setPeers(data.peers ?? []);
    } catch {
      setError('Failed to load peers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPeers();
  }, [fetchPeers]);

  const addPeer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPeerUrl.trim()) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/admin/federation/peers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          peerUrl: newPeerUrl.trim(),
          label: newPeerLabel.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to add peer');
      }
      setNewPeerUrl('');
      setNewPeerLabel('');
      setShowAddForm(false);
      await fetchPeers();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add peer');
    } finally {
      setSubmitting(false);
    }
  };

  const togglePeer = async (peerUrl: string, field: 'enabled' | 'push' | 'fetch' | 'sync', currentValue: number) => {
    try {
      await fetch('/api/admin/federation/peers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerUrl, [field]: currentValue ? 0 : 1 }),
      });
      await fetchPeers();
    } catch {
      setError('Failed to update peer');
    }
  };

  const removePeer = async (peerUrl: string) => {
    if (!confirm(`Remove peer ${peerUrl}?`)) return;
    try {
      await fetch(`/api/admin/federation/peers?peerUrl=${encodeURIComponent(peerUrl)}`, {
        method: 'DELETE',
      });
      await fetchPeers();
    } catch {
      setError('Failed to remove peer');
    }
  };

  return (
    <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 overflow-hidden mb-6">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Peer Nodes</h2>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {peers.length} configured
          </span>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="text-xs px-3 py-1.5 rounded-lg bg-orange-500 hover:bg-orange-600 text-white font-medium transition-colors"
        >
          {showAddForm ? 'Cancel' : '+ Add Peer'}
        </button>
      </div>

      {error && (
        <div className="px-6 py-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs">
          {error}
        </div>
      )}

      {showAddForm && (
        <form onSubmit={addPeer} className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">Relay URL</label>
              <input
                type="url"
                value={newPeerUrl}
                onChange={(e) => setNewPeerUrl(e.target.value)}
                placeholder="https://relay.example.com"
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                required
              />
            </div>
            <div className="sm:w-48">
              <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">Label (optional)</label>
              <input
                type="text"
                value={newPeerLabel}
                onChange={(e) => setNewPeerLabel(e.target.value)}
                placeholder="e.g. ATX Relay"
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-orange-500 focus:border-transparent"
              />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 text-sm rounded-lg bg-orange-500 hover:bg-orange-600 disabled:bg-gray-400 text-white font-medium transition-colors"
              >
                {submitting ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>
        </form>
      )}

      {loading ? (
        <p className="px-6 py-8 text-sm text-gray-400 dark:text-gray-500 text-center">Loading…</p>
      ) : peers.length === 0 ? (
        <p className="px-6 py-8 text-sm text-gray-400 dark:text-gray-500 text-center">
          No peers configured — add a relay URL to start syncing
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Peer</th>
                <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Push</th>
                <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Fetch</th>
                <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Sync</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Last Synced</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {peers.map((peer) => (
                <tr
                  key={peer.peer_url}
                  className={`hover:bg-gray-50 dark:hover:bg-gray-700/40 ${
                    !peer.enabled ? 'opacity-50' : ''
                  }`}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => togglePeer(peer.peer_url, 'enabled', peer.enabled)}
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          peer.enabled
                            ? 'bg-green-500'
                            : 'bg-gray-300 dark:bg-gray-600'
                        }`}
                        title={peer.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                      />
                      <div>
                        <p className="font-mono text-xs text-gray-900 dark:text-white">{peer.peer_url}</p>
                        {peer.label && (
                          <p className="text-xs text-gray-500 dark:text-gray-400">{peer.label}</p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="text-center px-3 py-3">
                    <button
                      onClick={() => togglePeer(peer.peer_url, 'push', peer.push)}
                      className={`text-xs px-2 py-0.5 rounded ${
                        peer.push
                          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-400'
                      }`}
                    >
                      {peer.push ? '✓' : '—'}
                    </button>
                  </td>
                  <td className="text-center px-3 py-3">
                    <button
                      onClick={() => togglePeer(peer.peer_url, 'fetch', peer.fetch)}
                      className={`text-xs px-2 py-0.5 rounded ${
                        peer.fetch
                          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-400'
                      }`}
                    >
                      {peer.fetch ? '✓' : '—'}
                    </button>
                  </td>
                  <td className="text-center px-3 py-3">
                    <button
                      onClick={() => togglePeer(peer.peer_url, 'sync', peer.sync)}
                      className={`text-xs px-2 py-0.5 rounded ${
                        peer.sync
                          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-400'
                      }`}
                    >
                      {peer.sync ? '✓' : '—'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {peer.last_synced
                      ? formatDistanceToNow(new Date(peer.last_synced), { addSuffix: true })
                      : 'never'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => removePeer(peer.peer_url)}
                      className="text-xs text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
