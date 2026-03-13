'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useIdentity } from '@/contexts/IdentityContext';

// Browser-safe DID derivation using Web Crypto API
async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function dmDid(did1: string, did2: string): Promise<string> {
  const sorted = [did1, did2].sort();
  const hash = (await sha256hex(sorted.join(':'))).slice(0, 16);
  return `did:imajin:dm:${hash}`;
}

async function groupDid(members: string[]): Promise<string> {
  const sorted = [...members].sort();
  const hash = (await sha256hex(sorted.join(':'))).slice(0, 16);
  return `did:imajin:group:${hash}`;
}

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

function displayName(conn: Connection): string {
  if (conn.name) return conn.name;
  if (conn.handle) return `@${conn.handle}`;
  if (conn.did.startsWith('did:email:')) return conn.did.slice('did:email:'.length);
  return conn.did.slice(0, 24) + '...';
}

export function NewChatModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { identity } = useIdentity();
  const [tab, setTab] = useState<'dm' | 'group'>('dm');
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // DM state
  const [creatingDm, setCreatingDm] = useState<string | null>(null);

  // Group state
  const [selectedDids, setSelectedDids] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');

  useEffect(() => {
    async function loadConnections() {
      try {
        const connRes = await fetch(`${CONNECTIONS_URL}/api/connections`, {
          credentials: 'include',
        });
        if (!connRes.ok) throw new Error('Failed to load connections');
        const connData = await connRes.json();

        const resolved = await Promise.all(
          (connData.connections || []).map(async (conn: Connection) => {
            try {
              const lookupRes = await fetch(
                `${AUTH_URL}/api/lookup/${encodeURIComponent(conn.did)}`,
                { credentials: 'include' }
              );
              if (lookupRes.ok) {
                const profile = await lookupRes.json();
                return { ...conn, handle: profile.handle, name: profile.name };
              }
            } catch {}
            return conn;
          })
        );

        // Deduplicate by DID (connections API may return one entry per pod)
        // and filter out the current user
        const seen = new Map<string, Connection>();
        for (const conn of resolved) {
          if (identity && conn.did === identity.did) continue; // exclude self
          if (conn.did.startsWith('did:email:')) continue; // soft DIDs cannot receive messages
          const existing = seen.get(conn.did);
          // Keep the entry with the most profile info
          if (!existing || (conn.name && !existing.name)) {
            seen.set(conn.did, conn);
          }
        }
        setConnections(Array.from(seen.values()));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load connections');
      } finally {
        setLoading(false);
      }
    }

    loadConnections();
  }, [identity]);

  async function startDm(connection: Connection) {
    if (!identity) return;
    setCreatingDm(connection.did);
    const did = await dmDid(identity.did, connection.did);
    router.push(`/conversations/${encodeURIComponent(did)}`);
    onClose();
  }

  async function createGroup() {
    if (!identity || selectedDids.size === 0) return;
    const members = [identity.did, ...Array.from(selectedDids)];
    const did = await groupDid(members);
    const params = groupName ? `?name=${encodeURIComponent(groupName)}` : '';
    router.push(`/conversations/${encodeURIComponent(did)}${params}`);
    onClose();
  }

  function toggleMember(did: string) {
    setSelectedDids((prev) => {
      const next = new Set(prev);
      if (next.has(did)) next.delete(did);
      else next.add(did);
      return next;
    });
  }

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

        {/* Tabs */}
        <div className="flex gap-4 mb-4 border-b border-gray-200 dark:border-gray-700">
          <button
            onClick={() => setTab('dm')}
            className={`pb-2 text-sm font-medium border-b-2 transition ${
              tab === 'dm'
                ? 'border-orange-500 text-orange-500'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            Direct Message
          </button>
          <button
            onClick={() => setTab('group')}
            className={`pb-2 text-sm font-medium border-b-2 transition ${
              tab === 'group'
                ? 'border-orange-500 text-orange-500'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            Create Group
          </button>
        </div>

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
              <a href={CONNECTIONS_URL} className="text-orange-500 hover:underline text-sm">
                Send an invite →
              </a>
            </div>
          ) : tab === 'dm' ? (
            <div className="space-y-1">
              {connections.map((conn) => (
                <button
                  key={`dm-${conn.did}`}
                  onClick={() => startDm(conn)}
                  disabled={creatingDm !== null}
                  className="w-full flex items-center justify-between p-3 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition text-left"
                >
                  <div className="min-w-0">
                    <p className="font-medium truncate">{displayName(conn)}</p>
                    {conn.handle && conn.name && (
                      <p className="text-sm text-gray-500 dark:text-gray-400">@{conn.handle}</p>
                    )}
                  </div>
                  <span className="text-sm text-orange-500 font-medium ml-3 shrink-0">
                    {creatingDm === conn.did ? '…' : 'Chat'}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            /* Group tab */
            <div>
              <div className="mb-3">
                <input
                  type="text"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Group name (optional)"
                  className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg text-sm outline-none focus:ring-2 focus:ring-orange-500/40"
                />
              </div>
              <p className="text-xs text-gray-500 mb-2 font-medium">Select members:</p>
              <div className="space-y-1">
                {connections.map((conn) => (
                  <label
                    key={`grp-${conn.did}`}
                    className="flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedDids.has(conn.did)}
                      onChange={() => toggleMember(conn.did)}
                      className="w-4 h-4 rounded accent-orange-500"
                    />
                    <div className="min-w-0">
                      <p className="font-medium truncate">{displayName(conn)}</p>
                      {conn.handle && conn.name && (
                        <p className="text-sm text-gray-500">@{conn.handle}</p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
              <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <button
                  onClick={createGroup}
                  disabled={selectedDids.size === 0}
                  className="w-full py-2.5 bg-orange-500 text-white rounded-lg font-medium hover:bg-orange-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {selectedDids.size > 0
                    ? `Create Group (${selectedDids.size + 1} members)`
                    : 'Select at least one member'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
