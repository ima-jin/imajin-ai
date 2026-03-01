'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const CONNECTIONS_URL = `${SERVICE_PREFIX}connections.${DOMAIN}`;
const AUTH_URL = `${SERVICE_PREFIX}auth.${DOMAIN}`;

interface Connection {
  did: string;
  handle?: string;
  name?: string;
  podId: string;
  podName: string;
}

export function NewChatModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadConnections() {
      try {
        // Fetch connections
        const connRes = await fetch(`${CONNECTIONS_URL}/api/connections`, {
          credentials: 'include',
        });
        if (!connRes.ok) throw new Error('Failed to load connections');
        const connData = await connRes.json();

        // Resolve handles for each connection
        const resolved = await Promise.all(
          (connData.connections || []).map(async (conn: any) => {
            try {
              const lookupRes = await fetch(`${AUTH_URL}/api/lookup/${encodeURIComponent(conn.did)}`, {
                credentials: 'include',
              });
              if (lookupRes.ok) {
                const profile = await lookupRes.json();
                return { ...conn, handle: profile.handle, name: profile.name };
              }
            } catch {}
            return conn;
          })
        );

        setConnections(resolved);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load connections');
      } finally {
        setLoading(false);
      }
    }

    loadConnections();
  }, []);

  async function startConversation(connection: Connection) {
    setCreating(connection.did);
    setError(null);

    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          type: 'direct',
          participantDids: [connection.did],
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create conversation');
      }

      const data = await res.json();
      const convId = data.conversation?.id;
      if (convId) {
        router.push(`/conversations/${convId}`);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start chat');
    } finally {
      setCreating(null);
    }
  }

  const displayName = (conn: Connection) => {
    if (conn.name) return conn.name;
    if (conn.handle) return `@${conn.handle}`;
    return conn.did.slice(0, 24) + '...';
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-6 w-full max-w-md mx-4 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">New Chat</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition text-xl"
          >
            ✕
          </button>
        </div>

        <p className="text-gray-500 dark:text-gray-400 text-sm mb-4">
          Start a conversation with one of your connections.
        </p>

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="py-8 text-center text-gray-500 text-sm">Loading connections…</div>
          ) : connections.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-gray-500 text-sm mb-3">No connections yet.</p>
              <a
                href={CONNECTIONS_URL}
                className="text-orange-500 hover:underline text-sm"
              >
                Send an invite →
              </a>
            </div>
          ) : (
            <div className="space-y-1">
              {connections.map((conn) => (
                <button
                  key={conn.did}
                  onClick={() => startConversation(conn)}
                  disabled={creating !== null}
                  className="w-full flex items-center justify-between p-3 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition text-left"
                >
                  <div className="min-w-0">
                    <p className="font-medium truncate">{displayName(conn)}</p>
                    {conn.handle && conn.name && (
                      <p className="text-sm text-gray-500 dark:text-gray-400">@{conn.handle}</p>
                    )}
                  </div>
                  <span className="text-sm text-orange-500 font-medium ml-3 shrink-0">
                    {creating === conn.did ? '...' : 'Chat'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
