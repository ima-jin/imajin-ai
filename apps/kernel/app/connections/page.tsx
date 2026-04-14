'use client';

import { useState, useEffect, useRef } from 'react';
import { useIdentity } from './context/IdentityContext';
import InvitationsTab from './invitations-tab';
import BumpConnect from './bump/BumpConnect';
import useSWR from 'swr';

import { buildPublicUrl } from '@imajin/config';

const AUTH_URL = buildPublicUrl('auth');
const PROFILE_URL = buildPublicUrl('profile');

interface Connection {
  did: string;
  handle?: string | null;
  name?: string | null;
  connectedAt: string;
  nickname?: string | null;
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

function NicknameEditor({
  conn,
  onSave,
}: {
  conn: Connection;
  onSave: (did: string, nickname: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(conn.nickname ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setValue(conn.nickname ?? '');
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, conn.nickname]);

  async function save() {
    const trimmed = value.trim();
    if (trimmed === (conn.nickname ?? '')) {
      setEditing(false);
      return;
    }
    if (trimmed) {
      await fetch(`/connections/api/connections/${encodeURIComponent(conn.did)}/nickname`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: trimmed }),
      });
      onSave(conn.did, trimmed);
    } else {
      await fetch(`/connections/api/connections/${encodeURIComponent(conn.did)}/nickname`, { method: 'DELETE' });
      onSave(conn.did, null);
    }
    setEditing(false);
  }

  async function clear() {
    await fetch(`/connections/api/connections/${encodeURIComponent(conn.did)}/nickname`, { method: 'DELETE' });
    onSave(conn.did, null);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={save}
          placeholder="Set nickname…"
          className="bg-white/10 border border-white/20 rounded px-2 py-0.5 text-sm text-white placeholder-gray-500 w-32 focus:outline-none focus:border-amber-500/50"
        />
        {value.trim() && (
          <button
            onMouseDown={(e) => { e.preventDefault(); clear(); }}
            className="text-gray-500 hover:text-red-400 transition text-xs"
            title="Clear nickname"
          >
            ×
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 min-w-0">
      {conn.nickname ? (
        <span className="font-medium text-white truncate">{conn.nickname}</span>
      ) : null}
      <button
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        className="text-gray-600 hover:text-amber-400 transition shrink-0"
        title="Edit nickname"
      >
        ✏️
      </button>
    </div>
  );
}

export default function ConnectionsPage() {
  const { did, handle, isLoggedIn, loading } = useIdentity();
  const [showBump, setShowBump] = useState(false);
  const [activeTab, setActiveTab] = useState<'connections' | 'groups' | 'invitations'>('connections');
  const [invitePending, setInvitePending] = useState(0);
  const [inviteRemaining, setInviteRemaining] = useState<number | null>(null);
  const [groupFilter, setGroupFilter] = useState<GroupFilter>('all');
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [sortMode, setSortMode] = useState<'date' | 'alpha'>('date');
  const [sortAsc, setSortAsc] = useState(false); // date defaults descending (newest first)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (tab === 'groups') setActiveTab('groups');
    else if (tab === 'invitations') setActiveTab('invitations');
  }, []);

  const { data: connectionsData, mutate: mutateConnections } = useSWR(
    isLoggedIn ? '/connections/api/connections' : null
  );
  const connections: Connection[] = connectionsData?.connections ?? [];

  const { data: podsData, mutate: mutatePods } = useSWR(
    isLoggedIn ? '/connections/api/groups' : null
  );
  const pods: Pod[] = podsData?.pods ?? [];

  function updateNickname(targetDid: string, nickname: string | null) {
    mutateConnections(
      (current: any) => ({
        ...current,
        connections: (current?.connections ?? []).map((c: Connection) =>
          c.did === targetDid ? { ...c, nickname } : c
        ),
      }),
      false
    );
  }

  async function disconnectFrom(connDid: string) {
    try {
      const res = await fetch(`/connections/api/connections/${encodeURIComponent(connDid)}`, { method: 'DELETE' });
      if (res.ok) {
        mutateConnections();
      }
    } catch {}
  }

  async function createGroup() {
    if (!newGroupName.trim()) return;
    setCreatingGroup(true);
    try {
      const res = await fetch('/connections/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newGroupName.trim(), description: newGroupDesc.trim() || undefined }),
      });
      if (res.ok) {
        const data = await res.json();
        setNewGroupName('');
        setNewGroupDesc('');
        setShowCreateGroup(false);
        mutatePods();
        window.location.href = `/connections/pods/${data.pod.id}`;
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
          href={`${PROFILE_URL}/login?next=${encodeURIComponent(`${AUTH_URL}`)}`}
          className="inline-block px-8 py-3 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg transition"
        >
          Sign In
        </a>
      </div>
    );
  }

    function displayLabel(conn: Connection): string {
    return (conn.nickname || conn.name || (conn.handle ? `@${conn.handle}` : conn.did)).toLowerCase();
  }

  const sortedConnections = [...connections].sort((a, b) => {
    const dir = sortAsc ? 1 : -1;
    if (sortMode === 'date') {
      return dir * (new Date(a.connectedAt).getTime() - new Date(b.connectedAt).getTime());
    }
    return dir * displayLabel(a).localeCompare(displayLabel(b));
  });

  const filteredPods = pods.filter((p) => {
    if (groupFilter === 'mine') return p.ownerDid === did;
    if (groupFilter === 'event') return p.type === 'event';
    return true;
  });

  return (
    <div className="max-w-2xl mx-auto">
      {/* Bump Connect overlay */}
      {showBump && <BumpConnect onClose={() => setShowBump(false)} />}

      {/* Bump entry button */}
      <div className="flex justify-end mb-4">
        <button
          onClick={() => setShowBump(true)}
          className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-orange-500/10 border border-white/10 hover:border-orange-500/30 text-gray-400 hover:text-orange-400 rounded-lg transition text-sm min-h-[48px]"
          title="Bump to connect"
        >
          <span>🤜🤛</span>
          <span>Bump</span>
        </button>
      </div>

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
            {invitePending > 0 && <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-yellow-500/20 text-yellow-300">{invitePending}</span>}
            {inviteRemaining !== null && inviteRemaining > 0 && <span className="ml-1 text-xs text-gray-500">{inviteRemaining} left</span>}
        </button>
      </div>

      {/* ─── Connections tab ─── */}
      {activeTab === 'connections' && (
        <>
          <div className="flex items-center justify-between mb-8">
            <p className="text-gray-400 text-sm">
              {connections.length} connection{connections.length !== 1 ? 's' : ''}
            </p>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-lg p-0.5">
                <button
                  onClick={() => { if (sortMode === 'date') setSortAsc(!sortAsc); else { setSortMode('date'); setSortAsc(false); } }}
                  className={`px-2 py-1 text-xs rounded transition ${
                    sortMode === 'date' ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'
                  }`}
                  title={sortMode === 'date' ? (sortAsc ? 'Oldest first' : 'Newest first') : 'Sort by date'}
                >
                  🕐 {sortMode === 'date' ? (sortAsc ? '↑' : '↓') : ''}
                </button>
                <button
                  onClick={() => { if (sortMode === 'alpha') setSortAsc(!sortAsc); else { setSortMode('alpha'); setSortAsc(true); } }}
                  className={`px-2 py-1 text-xs rounded transition ${
                    sortMode === 'alpha' ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'
                  }`}
                  title={sortMode === 'alpha' ? (sortAsc ? 'A → Z' : 'Z → A') : 'Sort by name'}
                >
                  Aa {sortMode === 'alpha' ? (sortAsc ? '↑' : '↓') : ''}
                </button>
              </div>
              <button
                onClick={() => setActiveTab('invitations')}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-black font-medium rounded-lg transition text-sm"
              >
                + Invite Someone
              </button>
            </div>
          </div>

          {/* Connections List */}
          {connections.length > 0 ? (
            <div className="space-y-3 mb-10">
              {sortedConnections.map((conn) => (
                <div
                  key={conn.did}
                  onClick={() => window.location.href = `${PROFILE_URL}/${conn.handle || conn.did}`}
                  className="flex items-center gap-4 p-4 bg-white/5 border border-white/10 rounded-lg cursor-pointer hover:bg-white/10 transition"
                >
                  <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-400 text-lg">
                    👤
                  </div>
                  <div className="flex-1 min-w-0 group">
                    {conn.nickname ? (
                      <>
                        <div className="flex items-center gap-1">
                          <NicknameEditor conn={conn} onSave={updateNickname} />
                        </div>
                        <div className="text-gray-400 text-sm truncate">
                          {conn.name || (conn.handle ? `@${conn.handle}` : conn.did.slice(0, 24) + '...')}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-1">
                          <span className="font-medium text-white truncate">
                            {conn.name || (conn.handle ? `@${conn.handle}` : conn.did.slice(0, 24) + '...')}
                          </span>
                          <NicknameEditor conn={conn} onSave={updateNickname} />
                        </div>
                        {conn.handle && conn.name && (
                          <div className="text-gray-400 text-sm">@{conn.handle}</div>
                        )}
                      </>
                    )}
                    <div className="text-gray-500 text-xs">
                      <span className="group-hover:hidden">
                        Connected {new Date(conn.connectedAt).toLocaleDateString()}
                      </span>
                      <span className="hidden group-hover:inline text-gray-600 font-mono text-[10px]">
                        {conn.did}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <a
                      href={`${buildPublicUrl('chat')}/start?did=${encodeURIComponent(conn.did)}`}
                      className="px-3 py-1.5 text-sm bg-white/10 hover:bg-white/20 text-white rounded-lg transition"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Message
                    </a>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Disconnect from ${conn.nickname || conn.name || conn.handle || 'this person'}? You'll need a new invite to reconnect.`)) {
                          disconnectFrom(conn.did);
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
      {activeTab === 'invitations' && <InvitationsTab onCountUpdate={(p, r) => { setInvitePending(p); setInviteRemaining(r); }} />}

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
                  href={`/connections/pods/${pod.id}`}
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
