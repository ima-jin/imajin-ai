'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useIdentity } from '@/src/contexts/IdentityContext';
import useSWR from 'swr';

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

import { buildPublicUrl } from '@imajin/config';
import { conversationPath } from '@/src/lib/chat/conversation-did';

const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const CONNECTIONS_URL = buildPublicUrl('connections');
const AUTH_URL = buildPublicUrl('auth', SERVICE_PREFIX, DOMAIN);

interface Connection {
  did: string;
  handle?: string;
  name?: string;
  tier?: string | null;
  podId: string;
  podName: string;
}

function displayName(conn: Connection): string {
  if (conn.name) return conn.name;
  if (conn.handle) return `@${conn.handle}`;
  return conn.did.slice(0, 24) + '...';
}

export function NewChatModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { identity } = useIdentity();
  const [tab, setTab] = useState<'dm' | 'group'>('dm');

  // DM state
  const [creatingDm, setCreatingDm] = useState<string | null>(null);

  // Group state
  const [selectedDids, setSelectedDids] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');

  const { data, isLoading, error } = useSWR(
    identity?.did ? `${CONNECTIONS_URL}/api/connections` : null
  );
  const connections = data?.connections ?? [];

  async function startDm(connection: Connection) {
    if (!identity) return;
    setCreatingDm(connection.did);
    const did = await dmDid(identity.did, connection.did);

    // Set conversationDid on the personal pod so both parties can discover the DM
    if (connection.podId) {
      try {
        await fetch(`${CONNECTIONS_URL}/api/groups/${connection.podId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ conversationDid: did }),
        });
      } catch {
        // Best-effort
      }
    }

    // Go through /start to ensure conversation + members are created
    // Use fetch to trigger the server-side create, then navigate to the redirect target
    try {
      const res = await fetch(`/start?did=${encodeURIComponent(connection.did)}`, {
        credentials: 'include',
        redirect: 'manual', // Don't follow redirect, we'll navigate client-side
      });
      // Extract redirect location or fall back to derived DID path
      const location = res.headers.get('Location');
      if (location) {
        const url = new URL(location, window.location.origin);
        router.push(url.pathname);
      } else {
        router.push(`/chat/conversations/${conversationPath(did)}`);
      }
    } catch {
      // Fallback: navigate directly (conversation may not have members yet)
      router.push(`/chat/conversations/${conversationPath(did)}`);
    }
    onClose();
  }

  async function createGroup() {
    if (!identity || selectedDids.size === 0) return;
    const name = groupName.trim() || 'Group Chat';

    // Server creates the group with a random DID and tracks members
    try {
      const res = await fetch(`/chat/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          type: 'group',
          name,
          participantDids: Array.from(selectedDids),
        }),
      });

      if (!res.ok) throw new Error('Failed to create group');
      const data = await res.json();
      const convDid = data.conversation?.did;

      if (convDid) {
        router.push(`/chat/conversations/${conversationPath(convDid)}`);
        onClose();
        return;
      }
    } catch (err) {
      console.error('Group creation failed:', err);
    }

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-base/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-surface-elevated p-6 w-full max-w-md mx-4 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold font-mono">New Chat</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 dark:hover:bg-surface-elevated transition text-xl"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-4 mb-4 border-b border-gray-200 dark:border-white/10">
          <button
            onClick={() => setTab('dm')}
            className={`pb-2 text-sm font-medium border-b-2 transition ${
              tab === 'dm'
                ? 'border-imajin-orange text-imajin-orange'
                : 'border-transparent text-secondary hover:text-gray-700 dark:hover:text-primary'
            }`}
          >
            Direct Message
          </button>
          <button
            onClick={() => setTab('group')}
            className={`pb-2 text-sm font-medium border-b-2 transition ${
              tab === 'group'
                ? 'border-imajin-orange text-imajin-orange'
                : 'border-transparent text-secondary hover:text-gray-700 dark:hover:text-primary'
            }`}
          >
            Create Group
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-error/10 dark:bg-error/20 text-error dark:text-error text-sm">
            Failed to load connections
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="py-8 text-center text-secondary text-sm">Loading connections…</div>
          ) : connections.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-secondary text-sm mb-3">No connections yet.</p>
              <a href={CONNECTIONS_URL} className="text-imajin-orange hover:underline text-sm">
                Send an invite →
              </a>
            </div>
          ) : tab === 'dm' ? (
            <div className="space-y-1">
              {connections.map((conn: Connection) => (
                <button
                  key={`dm-${conn.did}`}
                  onClick={() => startDm(conn)}
                  disabled={creatingDm !== null}
                  className="w-full flex items-center justify-between p-3 hover:bg-gray-50 dark:hover:bg-surface-elevated transition text-left"
                >
                  <div className="min-w-0">
                    <p className="font-medium truncate">{displayName(conn)}</p>
                    {conn.handle && conn.name && (
                      <p className="text-sm text-secondary dark:text-secondary">@{conn.handle}</p>
                    )}
                  </div>
                  <span className="text-sm text-imajin-orange font-medium ml-3 shrink-0">
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
                  className="w-full px-3 py-2 bg-gray-100 dark:bg-surface-elevated text-sm outline-none focus:ring-2 focus:ring-imajin-purple/40"
                />
              </div>
              <p className="text-xs text-secondary mb-2 font-medium">Select members:</p>
              <div className="space-y-1">
                {connections.map((conn: Connection) => (
                  <label
                    key={`grp-${conn.did}`}
                    className="flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-surface-elevated cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedDids.has(conn.did)}
                      onChange={() => toggleMember(conn.did)}
                      className="w-4 h-4 accent-imajin-purple"
                    />
                    <div className="min-w-0">
                      <p className="font-medium truncate">{displayName(conn)}</p>
                      {conn.handle && conn.name && (
                        <p className="text-sm text-secondary">@{conn.handle}</p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
              <div className="mt-4 pt-4 border-t border-gray-200 dark:border-white/10">
                <button
                  onClick={createGroup}
                  disabled={selectedDids.size === 0}
                  style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className="w-full py-2.5 hover:brightness-110 text-primary font-medium hover:bg-imajin-orange transition disabled:opacity-50 disabled:cursor-not-allowed"
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
