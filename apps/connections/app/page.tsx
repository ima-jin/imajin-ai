'use client';

import { useState, useEffect } from 'react';
import { useIdentity } from './context/IdentityContext';

const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const AUTH_URL = `${SERVICE_PREFIX}auth.${DOMAIN}`;
const PROFILE_URL = `${SERVICE_PREFIX}profile.${DOMAIN}`;

interface Connection {
  podId: string;
  podName: string;
  did: string;
  handle?: string;
  joinedAt: string;
}

interface Invite {
  id: string;
  code: string;
  fromHandle?: string;
  toEmail?: string;
  note?: string;
  usedCount: number;
  maxUses: number;
  consumedAt?: string;
  createdAt: string;
  daysAgo: number;
  url: string;
}

export default function ConnectionsPage() {
  const { did, handle, isLoggedIn, loading } = useIdentity();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteNote, setInviteNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  useEffect(() => {
    if (isLoggedIn) {
      fetchConnections();
      fetchInvites();
    }
  }, [isLoggedIn]);

  async function fetchConnections() {
    try {
      const res = await fetch('/api/connections');
      if (res.ok) {
        const data = await res.json();
        const conns = data.connections || [];

        // Resolve handles from auth service
        const resolved = await Promise.all(
          conns.map(async (conn: Connection) => {
            try {
              const lookupRes = await fetch(
                `${AUTH_URL}/api/lookup/${encodeURIComponent(conn.did)}`
              );
              if (lookupRes.ok) {
                const profile = await lookupRes.json();
                return { ...conn, handle: profile.handle, name: profile.name };
              }
            } catch {}
            return conn;
          })
        );

        setConnections(resolved);
      }
    } catch {}
  }

  async function fetchInvites() {
    try {
      const res = await fetch('/api/invites');
      if (res.ok) {
        const data = await res.json();
        setInvites(data.invites || []);
      }
    } catch {}
  }

  async function createInvite() {
    setCreating(true);
    try {
      const res = await fetch('/api/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: inviteNote || undefined }),
      });
      if (res.ok) {
        setInviteNote('');
        setShowInviteForm(false);
        fetchInvites();
      }
    } catch {} finally {
      setCreating(false);
    }
  }

  async function deleteInvite(code: string) {
    try {
      await fetch(`/api/invites/${code}`, { method: 'DELETE' });
      fetchInvites();
    } catch {}
  }

  function copyLink(url: string, code: string) {
    navigator.clipboard.writeText(url);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <div className="text-6xl mb-6">🟠</div>
        <h1 className="text-3xl font-bold mb-3">Imajin Connections</h1>
        <p className="text-gray-400 mb-8">Sign in to manage your trusted connections.</p>
        <a
          href={`${PROFILE_URL}/login?next=${encodeURIComponent(`${SERVICE_PREFIX}connections.${DOMAIN}`)}`}
          className="inline-block px-8 py-3 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg transition"
        >
          Sign In
        </a>
      </div>
    );
  }

  const pendingInvites = invites.filter((i) => i.usedCount < i.maxUses);
  const usedInvites = invites.filter((i) => i.usedCount >= i.maxUses);

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Your Connections</h1>
          <p className="text-gray-400 text-sm mt-1">
            {connections.length} connection{connections.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => setShowInviteForm(!showInviteForm)}
          className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-black font-medium rounded-lg transition"
        >
          + Invite Someone
        </button>
      </div>

      {/* Invite Form */}
      {showInviteForm && (
        <div className="mb-8 p-6 bg-white/5 border border-amber-500/30 rounded-lg">
          <h3 className="text-lg font-semibold mb-3">Create an Invite</h3>
          <textarea
            value={inviteNote}
            onChange={(e) => setInviteNote(e.target.value)}
            placeholder="Add a personal note (optional)"
            className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-white placeholder-gray-500 text-sm resize-none mb-3"
            rows={2}
          />
          <div className="flex gap-2">
            <button
              onClick={createInvite}
              disabled={creating}
              className="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg transition"
            >
              {creating ? 'Creating...' : 'Generate Invite Link'}
            </button>
            <button
              onClick={() => setShowInviteForm(false)}
              className="px-4 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Connections List */}
      {connections.length > 0 ? (
        <div className="space-y-3 mb-10">
          {connections.map((conn) => (
            <div
              key={conn.podId}
              className="flex items-center gap-4 p-4 bg-white/5 border border-white/10 rounded-lg"
            >
              <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-400 text-lg">
                👤
              </div>
              <div className="flex-1 min-w-0 group">
                <div className="font-medium text-white truncate">
                  {conn.name || (conn.handle ? `@${conn.handle}` : conn.did.slice(0, 24) + '...')}
                </div>
                {conn.handle && conn.name && (
                  <div className="text-gray-400 text-sm">@{conn.handle}</div>
                )}
                <div className="text-gray-500 text-xs">
                  <span className="group-hover:hidden">
                    Connected {new Date(conn.joinedAt).toLocaleDateString()}
                  </span>
                  <span className="hidden group-hover:inline text-gray-600 font-mono text-[10px]">
                    {conn.did}
                  </span>
                </div>
              </div>
              <a
                href={`${SERVICE_PREFIX}chat.${DOMAIN}?start=${encodeURIComponent(conn.did)}`}
                className="px-3 py-1.5 text-sm bg-white/10 hover:bg-white/20 text-white rounded-lg transition"
              >
                Message
              </a>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12 mb-10 bg-white/5 border border-white/10 rounded-lg">
          <div className="text-4xl mb-3">🤝</div>
          <p className="text-gray-400">No connections yet. Invite someone to get started!</p>
        </div>
      )}

      {/* Pending Invites */}
      {pendingInvites.length > 0 && (
        <div>
          <h2 className="text-xl font-semibold mb-4">Pending Invites</h2>
          <div className="space-y-3">
            {pendingInvites.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center gap-4 p-4 bg-white/5 border border-white/10 rounded-lg"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-300">
                    {inv.note || 'No note'}
                    {inv.toEmail && <span className="text-gray-500"> · {inv.toEmail}</span>}
                  </div>
                  <div className="text-gray-500 text-xs mt-1">
                    {inv.daysAgo === 0 ? 'Today' : `${inv.daysAgo} day${inv.daysAgo !== 1 ? 's' : ''} ago`}
                  </div>
                </div>
                <button
                  onClick={() => copyLink(inv.url, inv.code)}
                  className="px-3 py-1.5 text-xs bg-white/10 hover:bg-white/15 text-white rounded-lg transition"
                >
                  {copiedCode === inv.code ? '✓ Copied' : 'Copy Link'}
                </button>
                <button
                  onClick={() => deleteInvite(inv.code)}
                  className="px-3 py-1.5 text-xs bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg transition"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
