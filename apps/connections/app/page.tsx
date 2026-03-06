'use client';

import { useState, useEffect } from 'react';
import { useIdentity } from './context/IdentityContext';
import InvitationsTab from './invitations-tab';

const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const AUTH_URL = `${SERVICE_PREFIX}auth.${DOMAIN}`;
const PROFILE_URL = `${SERVICE_PREFIX}profile.${DOMAIN}`;

interface Connection {
  podId: string;
  podName: string;
  did: string;
  handle?: string;
  name?: string;
  joinedAt: string;
}

interface Pod {
  id: string;
  name: string;
  description: string | null;
  type: 'shared' | 'event';
  ownerDid: string;
  createdAt: string;
  memberCount: number;
}

type GroupFilter = 'all' | 'mine' | 'event';

export default function ConnectionsPage() {
  const { did, handle, isLoggedIn, loading } = useIdentity();
  const [activeTab, setActiveTab] = useState<'connections' | 'groups' | 'invitations'>('connections');
  const [connections, setConnections] = useState<Connection[]>([]);
  const [pods, setPods] = useState<Pod[]>([]);
  const [groupFilter, setGroupFilter] = useState<GroupFilter>('all');
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (tab === 'groups') setActiveTab('groups');
    else if (tab === 'invitations') setActiveTab('invitations');
  }, []);

  useEffect(() => {
    if (isLoggedIn) {
      fetchConnections();
      fetchPods();
    }
  }, [isLoggedIn]);

  async function fetchConnections() {
    try {
      const res = await fetch('/api/connections');
      if (res.ok) {
        const data = await res.json();
        setConnections(data.connections || []);
      }
    } catch {}
  }

  async function fetchPods() {
    try {
      const res = await fetch('/api/groups');
      if (res.ok) {
        const data = await res.json();
        setPods(data.pods || []);
      }
    } catch {}
  }

  async function disconnectFrom(podId: string) {
    try {
      const res = await fetch(`/api/connections/${podId}`, { method: 'DELETE' });
      if (res.ok) {
        fetchConnections();
      }
    } catch {}
  }

  async function createGroup() {
    if (!newGroupName.trim()) return;
    setCreatingGroup(true);
    try {
      const res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newGroupName.trim(), description: newGroupDesc.trim() || undefined }),
      });
      if (res.ok) {
        const data = await res.json();
        setNewGroupName('');
        setNewGroupDesc('');
        setShowCreateGroup(false);
        fetchPods();
        window.location.href = `/pods/${data.pod.id}`;
      }
    } catch {} finally {
      setCreatingGroup(false);
    }
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

  const filteredPods = pods.filter((p) => {
    if (groupFilter === 'mine') return p.ownerDid === did;
    if (groupFilter === 'event') return p.type === 'event';
    return true;
  });

  return (
    <div className="max-w-2xl mx-auto">
      {/* Tab navigation */}
      <div className="flex gap-1 mb-8 border-b border-white/10">
        <button
          onClick={() => setActiveTab('connections')}
          className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
            activeTab === 'connections'
              ? 'border-amber-500 text-amber-400'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          Connections
          {connections.length > 0 && (
            <span className="ml-2 px-1.5 py-0.5 text-xs bg-white/10 rounded-full">{connections.length}</span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('groups')}
          className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
            activeTab === 'groups'
              ? 'border-amber-500 text-amber-400'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          Groups
          {pods.length > 0 && (
            <span className="ml-2 px-1.5 py-0.5 text-xs bg-white/10 rounded-full">{pods.length}</span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('invitations')}
          className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
            activeTab === 'invitations'
              ? 'border-amber-500 text-amber-400'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          Invitations
        </button>
      </div>

      {/* ─── Connections tab ─── */}
      {activeTab === 'connections' && (
        <>
          <div className="flex items-center justify-between mb-8">
            <p className="text-gray-400 text-sm">
              {connections.length} connection{connections.length !== 1 ? 's' : ''}
            </p>
            <button
              onClick={() => setActiveTab('invitations')}
              className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-black font-medium rounded-lg transition text-sm"
            >
              + Invite Someone
            </button>
          </div>

          {/* Connections List */}
          {connections.length > 0 ? (
            <div className="space-y-3 mb-10">
              {connections.map((conn) => (
                <div
                  key={conn.podId}
                  onClick={() => window.location.href = `${PROFILE_URL}/${conn.handle || conn.did}`}
                  className="flex items-center gap-4 p-4 bg-white/5 border border-white/10 rounded-lg cursor-pointer hover:bg-white/10 transition"
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
                  <div className="flex items-center gap-2">
                    <a
                      href={`${SERVICE_PREFIX}chat.${DOMAIN}/start?did=${encodeURIComponent(conn.did)}`}
                      className="px-3 py-1.5 text-sm bg-white/10 hover:bg-white/20 text-white rounded-lg transition"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Message
                    </a>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Disconnect from ${conn.name || conn.handle || 'this person'}? You'll need a new invite to reconnect.`)) {
                          disconnectFrom(conn.podId);
                        }
                      }}
                      className="px-3 py-1.5 text-sm bg-white/5 hover:bg-red-500/20 text-gray-500 hover:text-red-400 rounded-lg transition"
                      title="Disconnect"
                    >
                      ⛓️‍💥
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 mb-10 bg-white/5 border border-white/10 rounded-lg">
              <div className="text-4xl mb-3">🤝</div>
              <p className="text-gray-400">No connections yet. Invite someone to get started!</p>
            </div>
          )}

        </>
      )}

      {/* ─── Invitations tab ─── */}
      {activeTab === 'invitations' && <InvitationsTab />}

      {/* ─── Groups tab ─── */}
      {activeTab === 'groups' && (
        <>
          <div className="flex items-center justify-between mb-6">
            {/* Filter pills */}
            <div className="flex gap-1">
              {(['all', 'mine', 'event'] as GroupFilter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setGroupFilter(f)}
                  className={`px-3 py-1 text-xs font-medium rounded-full transition ${
                    groupFilter === f
                      ? 'bg-amber-500 text-black'
                      : 'bg-white/10 text-gray-400 hover:text-white'
                  }`}
                >
                  {f === 'all' ? 'All' : f === 'mine' ? 'My Groups' : 'Event Groups'}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowCreateGroup(!showCreateGroup)}
              className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-black font-medium rounded-lg transition text-sm"
            >
              + Create Group
            </button>
          </div>

          {/* Create group form */}
          {showCreateGroup && (
            <div className="mb-6 p-5 bg-white/5 border border-amber-500/30 rounded-lg">
              <h3 className="text-base font-semibold mb-3">New Group</h3>
              <input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="Group name (required)"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white placeholder-gray-500 text-sm mb-2"
              />
              <textarea
                value={newGroupDesc}
                onChange={(e) => setNewGroupDesc(e.target.value)}
                placeholder="Description (optional)"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white placeholder-gray-500 text-sm resize-none mb-3"
                rows={2}
              />
              <div className="flex gap-2">
                <button
                  onClick={createGroup}
                  disabled={creatingGroup || !newGroupName.trim()}
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg transition text-sm"
                >
                  {creatingGroup ? 'Creating...' : 'Create Group'}
                </button>
                <button
                  onClick={() => { setShowCreateGroup(false); setNewGroupName(''); setNewGroupDesc(''); }}
                  className="px-4 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg transition text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Groups list */}
          {filteredPods.length > 0 ? (
            <div className="space-y-3">
              {filteredPods.map((pod) => (
                <a
                  key={pod.id}
                  href={`/pods/${pod.id}`}
                  className="flex items-center gap-4 p-4 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10 transition"
                >
                  <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-400 text-lg shrink-0">
                    {pod.type === 'event' ? '🎟️' : '👥'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-medium text-white truncate">{pod.name}</span>
                      <span className={`px-1.5 py-0.5 text-xs rounded-full font-medium shrink-0 ${
                        pod.type === 'event'
                          ? 'bg-purple-500/20 text-purple-300'
                          : 'bg-amber-500/20 text-amber-300'
                      }`}>
                        {pod.type === 'event' ? 'Event' : 'Group'}
                      </span>
                    </div>
                    {pod.description && (
                      <div className="text-gray-400 text-xs truncate mb-0.5">{pod.description}</div>
                    )}
                    <div className="text-gray-500 text-xs">
                      {pod.memberCount} member{pod.memberCount !== 1 ? 's' : ''} · {new Date(pod.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="text-gray-600 shrink-0">›</div>
                </a>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 bg-white/5 border border-white/10 rounded-lg">
              <div className="text-4xl mb-3">👥</div>
              <p className="text-gray-400">
                {groupFilter === 'all'
                  ? 'No groups yet. Create one to get started!'
                  : groupFilter === 'mine'
                  ? "You haven't created any groups yet."
                  : 'No event groups found.'}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
