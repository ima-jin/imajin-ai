'use client';

import { useState, useEffect } from 'react';
import { useIdentity } from '../../context/IdentityContext';
import { ConnectionPicker, useToast } from '@imajin/ui';

const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const AUTH_URL = `${SERVICE_PREFIX}auth.${DOMAIN}`;
const PROFILE_URL = `${SERVICE_PREFIX}profile.${DOMAIN}`;

interface Member {
  podId: string;
  did: string;
  role: 'owner' | 'admin' | 'member';
  addedBy: string | null;
  joinedAt: string;
  removedAt: string | null;
  handle: string | null;
  name: string | null;
}

interface Pod {
  id: string;
  name: string;
  description: string | null;
  type: 'personal' | 'shared' | 'event';
  visibility: string;
  ownerDid: string;
  createdAt: string;
  memberCount: number;
}


export default function PodDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const { did, isLoggedIn, loading } = useIdentity();
  const { toast } = useToast();
  const [pod, setPod] = useState<Pod | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loadingPod, setLoadingPod] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isLoggedIn) {
      fetchPod();
    }
  }, [isLoggedIn, id]);

  async function fetchPod() {
    setLoadingPod(true);
    try {
      const res = await fetch(`/api/groups/${id}`);
      if (res.ok) {
        const data = await res.json();
        setPod(data.pod);
        setMembers(data.members || []);
      } else {
        setError('Group not found or you are not a member.');
      }
    } catch {
      setError('Failed to load group.');
    } finally {
      setLoadingPod(false);
    }
  }

  async function saveEdit() {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/groups/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, description: editDesc }),
      });
      if (res.ok) {
        const data = await res.json();
        setPod((prev) => prev ? { ...prev, ...data.pod } : null);
        setEditing(false);
      }
    } catch {} finally {
      setSaving(false);
    }
  }

  async function addMember(memberDid: string) {
    setAdding(true);
    try {
      const res = await fetch(`/api/groups/${id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did: memberDid }),
      });
      if (res.ok) {
        setShowAddMember(false);
        fetchPod();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to add member');
      }
    } catch {} finally {
      setAdding(false);
    }
  }

  async function removeMember(memberDid: string) {
    const member = members.find((m) => m.did === memberDid);
    const label = member?.name || (member?.handle ? `@${member.handle}` : memberDid.slice(0, 16) + '...');
    if (!confirm(`Remove ${label} from this group?`)) return;

    try {
      const res = await fetch(`/api/groups/${id}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did: memberDid }),
      });
      if (res.ok) {
        fetchPod();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to remove member');
      }
    } catch {}
  }

  async function deleteGroup() {
    if (!confirm(`Delete "${pod?.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/groups/${id}`, { method: 'DELETE' });
      if (res.ok) {
        window.location.href = '/?tab=groups';
      } else {
        toast.error('Failed to delete group');
      }
    } catch {}
  }

  const isOwner = pod?.ownerDid === did;
  const isEvent = pod?.type === 'event';
  const isReadOnly = isEvent;

  const memberDids = members.map((m) => m.did);

  if (loading || loadingPod) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <h1 className="text-2xl font-bold mb-4">Sign in required</h1>
        <a
          href={`${PROFILE_URL}/login?next=${encodeURIComponent(`${SERVICE_PREFIX}connections.${DOMAIN}`)}`}
          className="inline-block px-8 py-3 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg transition"
        >
          Sign In
        </a>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <div className="text-gray-400 mb-4">{error}</div>
        <a href="/?tab=groups" className="text-amber-400 hover:underline">Back to Groups</a>
      </div>
    );
  }

  if (!pod) return null;

  return (
    <div className="max-w-2xl mx-auto">
      {/* Back link */}
      <div className="mb-6">
        <a href="/?tab=groups" className="text-gray-400 hover:text-white text-sm transition">
          ← Back to Groups
        </a>
      </div>

      {/* Pod header */}
      <div className="p-6 bg-white/5 border border-white/10 rounded-lg mb-6">
        {editing ? (
          <div className="space-y-3">
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-lg font-semibold"
              placeholder="Group name"
            />
            <textarea
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm resize-none"
              placeholder="Description (optional)"
              rows={2}
            />
            <div className="flex gap-2">
              <button
                onClick={saveEdit}
                disabled={saving || !editName.trim()}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg transition text-sm"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="px-4 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg transition text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-2xl font-bold">{pod.name}</h1>
                <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${
                  pod.type === 'event'
                    ? 'bg-purple-500/20 text-purple-300'
                    : 'bg-amber-500/20 text-amber-300'
                }`}>
                  {pod.type === 'event' ? 'Event' : 'Group'}
                </span>
                {isReadOnly && (
                  <span className="px-2 py-0.5 text-xs rounded-full bg-white/10 text-gray-400">Read-only</span>
                )}
              </div>
              {pod.description && (
                <p className="text-gray-400 text-sm mb-2">{pod.description}</p>
              )}
              <p className="text-gray-500 text-xs">
                {pod.memberCount} member{pod.memberCount !== 1 ? 's' : ''} · Created {new Date(pod.createdAt).toLocaleDateString()}
              </p>
            </div>
            {isOwner && !isReadOnly && (
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => {
                    setEditName(pod.name);
                    setEditDesc(pod.description || '');
                    setEditing(true);
                  }}
                  className="px-3 py-1.5 text-sm bg-white/10 hover:bg-white/15 text-white rounded-lg transition"
                >
                  Edit
                </button>
                <button
                  onClick={deleteGroup}
                  className="px-3 py-1.5 text-sm bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg transition"
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Members section */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Members</h2>
          {isOwner && !isReadOnly && (
            <button
              onClick={() => setShowAddMember(!showAddMember)}
              className="px-3 py-1.5 text-sm bg-amber-500 hover:bg-amber-600 text-black font-medium rounded-lg transition"
            >
              + Add Member
            </button>
          )}
        </div>

        {/* Add member panel */}
        {showAddMember && (
          <div className="mb-4 p-4 bg-white/5 border border-amber-500/30 rounded-lg">
            <p className="text-sm text-gray-400 mb-3">Select from your connections:</p>
            <ConnectionPicker
              connectionsUrl="/api/connections"
              excludeDids={memberDids}
              onSelect={(conn) => addMember(conn.did)}
              disabled={adding}
            />
            <div className="mt-3">
              <button
                onClick={() => setShowAddMember(false)}
                className="px-4 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg transition text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Member list */}
        <div className="space-y-2">
          {members.map((member) => (
            <div
              key={member.did}
              className="flex items-center gap-3 p-3 bg-white/5 border border-white/10 rounded-lg"
            >
              <div
                className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-400 text-lg shrink-0 cursor-pointer"
                onClick={() => {
                  if (member.handle) window.open(`${PROFILE_URL}/${member.handle}`, '_blank');
                }}
              >
                👤
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-white text-sm truncate">
                    {member.name || (member.handle ? `@${member.handle}` : member.did.slice(0, 24) + '...')}
                  </span>
                  <span className={`px-1.5 py-0.5 text-xs rounded font-medium shrink-0 ${
                    member.role === 'owner'
                      ? 'bg-amber-500/20 text-amber-300'
                      : member.role === 'admin'
                      ? 'bg-blue-500/20 text-blue-300'
                      : 'bg-white/10 text-gray-400'
                  }`}>
                    {member.role}
                  </span>
                </div>
                {member.handle && member.name && (
                  <div className="text-gray-400 text-xs">@{member.handle}</div>
                )}
                <div className="text-gray-500 text-xs">
                  Joined {new Date(member.joinedAt).toLocaleDateString()}
                </div>
              </div>
              {isOwner && !isReadOnly && member.did !== did && (
                <button
                  onClick={() => removeMember(member.did)}
                  className="px-2 py-1 text-xs bg-white/5 hover:bg-red-500/20 text-gray-500 hover:text-red-400 rounded transition shrink-0"
                  title="Remove member"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
