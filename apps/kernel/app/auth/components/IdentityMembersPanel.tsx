'use client';

import { useState, useEffect } from 'react';

interface Controller {
  controllerDid: string;
  role: string;
  addedBy: string;
  addedAt: string;
}

const ROLE_STYLES: Record<string, string> = {
  owner: 'border-amber-600 text-warning bg-warning/20',
  admin: 'border-blue-700 text-blue-400 bg-blue-900/20',
  maintainer: 'border-sky-700 text-sky-400 bg-sky-900/20',
  member: 'border-white/10 text-secondary bg-surface-surface/20',
};

const ADD_ROLES = ['admin', 'maintainer', 'member'];

export default function IdentityMembersPanel({ groupDid }: { groupDid: string }) {
  const [loading, setLoading] = useState(true);
  const [controllers, setControllers] = useState<Controller[]>([]);
  const [addDid, setAddDid] = useState('');
  const [addRole, setAddRole] = useState('member');
  const [addingMember, setAddingMember] = useState(false);
  const [removingDid, setRemovingDid] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const authUrl =
    typeof window !== 'undefined' ? window.location.origin : (process.env.NEXT_PUBLIC_AUTH_URL ?? '');

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupDid]);

  async function loadData() {
    setLoading(true);
    try {
      const res = await fetch(
        `${authUrl}/api/groups/${encodeURIComponent(groupDid)}`,
        { credentials: 'include' }
      );
      if (res.ok) {
        const data = await res.json();
        setControllers(data.controllers ?? []);
      }
    } catch (err) {
      console.error('Failed to load members:', err);
    } finally {
      setLoading(false);
    }
  }

  function showStatus(type: 'success' | 'error', text: string) {
    setStatus({ type, text });
    setTimeout(() => setStatus(null), 5000);
  }

  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault();
    if (!addDid.trim()) return;
    setAddingMember(true);
    try {
      const res = await fetch(
        `${authUrl}/api/groups/${encodeURIComponent(groupDid)}/controllers`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ did: addDid.trim(), role: addRole }),
        }
      );
      if (res.ok) {
        setAddDid('');
        setAddRole('member');
        showStatus('success', 'Member added.');
        await loadData();
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Failed to add member.');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setAddingMember(false);
    }
  }

  async function handleRemoveMember(controllerDid: string) {
    setRemovingDid(controllerDid);
    try {
      const res = await fetch(
        `${authUrl}/api/groups/${encodeURIComponent(groupDid)}/controllers/${encodeURIComponent(controllerDid)}`,
        { method: 'DELETE', credentials: 'include' }
      );
      if (res.ok) {
        showStatus('success', 'Member removed.');
        await loadData();
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Failed to remove member.');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setRemovingDid(null);
    }
  }

  if (loading) {
    return <div className="text-secondary py-8">Loading members…</div>;
  }

  return (
    <div className="space-y-6">
      {status && (
        <div
          className={`p-4 border ${
            status.type === 'success'
              ? 'bg-success/20 border-green-800 text-success'
              : 'bg-error/20 border-red-800 text-error'
          }`}
        >
          {status.text}
        </div>
      )}

      <div className="bg-[#0a0a0a] border border-white/10 p-6">
        <div className="flex items-center gap-3 mb-1">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-secondary font-mono">Members</h2>
          {controllers.length > 0 && (
            <span className="px-1.5 py-0.5 text-xs bg-surface-elevated text-secondary font-mono">
              {controllers.length}
            </span>
          )}
        </div>
        <p className="text-sm text-secondary mb-6">People who can manage this identity.</p>

        {controllers.length === 0 ? (
          <p className="text-sm text-secondary mb-6">No members found.</p>
        ) : (
          <div className="space-y-2 mb-6">
            {controllers.map((ctrl) => {
              const isOwner = ctrl.role === 'owner';
              const roleStyle = ROLE_STYLES[ctrl.role] ?? ROLE_STYLES.member;
              const isRemoving = removingDid === ctrl.controllerDid;
              return (
                <div
                  key={ctrl.controllerDid}
                  className="flex items-center justify-between p-3 bg-surface-surface border border-white/10"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-xl flex-shrink-0">👤</span>
                    <div className="min-w-0">
                      <p className="text-sm text-primary font-medium font-mono truncate">
                        {ctrl.controllerDid.length > 32
                          ? ctrl.controllerDid.slice(0, 28) + '…'
                          : ctrl.controllerDid}
                      </p>
                      <p className="text-xs text-secondary">
                        Added {new Date(ctrl.addedAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                    <span className={`px-2 py-0.5 text-xs  border capitalize ${roleStyle}`}>
                      {ctrl.role}
                    </span>
                    {!isOwner && (
                      <button
                        onClick={() => handleRemoveMember(ctrl.controllerDid)}
                        disabled={isRemoving}
                        className="w-6 h-6 flex items-center justify-center text-muted hover:text-error hover:bg-error/20 transition disabled:opacity-40"
                        title="Remove member"
                      >
                        {isRemoving ? '…' : '×'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Add member form */}
        <form onSubmit={handleAddMember} className="flex gap-2">
          <input
            type="text"
            value={addDid}
            onChange={(e) => setAddDid(e.target.value)}
            placeholder="DID or handle"
            className="flex-1 px-3 py-2 bg-surface-surface border border-white/10 text-sm text-primary placeholder-muted focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-transparent"
          />
          <select
            value={addRole}
            onChange={(e) => setAddRole(e.target.value)}
            className="px-3 py-2 bg-surface-surface border border-white/10 text-sm text-primary focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-transparent"
          >
            {ADD_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={addingMember || !addDid.trim()}
            className="px-4 py-2 bg-surface-elevated hover:bg-surface-elevated border border-white/10 text-sm text-primary transition disabled:opacity-40 whitespace-nowrap"
          >
            {addingMember ? 'Adding…' : 'Add'}
          </button>
        </form>
      </div>
    </div>
  );
}
