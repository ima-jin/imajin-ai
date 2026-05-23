'use client';

import { useState, useEffect } from 'react';
import IdentityPicker from './IdentityPicker';
import { SERVICES } from '@imajin/config';

interface Controller {
  controllerDid: string;
  role: string;
  addedBy: string;
  addedAt: string;
  allowedServices: string[] | null;
}

const ROLE_STYLES: Record<string, string> = {
  owner: 'border-amber-600 text-amber-400 bg-amber-900/20',
  admin: 'border-blue-700 text-blue-400 bg-blue-900/20',
  maintainer: 'border-sky-700 text-sky-400 bg-sky-900/20',
  member: 'border-gray-700 text-gray-400 bg-gray-900/20',
};

const ADD_ROLES = ['admin', 'maintainer', 'member'];

const SELECTABLE_SERVICES = SERVICES.filter(
  (s) =>
    s.visibility !== 'internal' &&
    s.category !== 'meta' &&
    s.category !== 'infrastructure' &&
    s.category !== 'kernel'
);

export default function IdentityMembersPanel({ groupDid }: Readonly<{ groupDid: string }>) {
  const [loading, setLoading] = useState(true);
  const [controllers, setControllers] = useState<Controller[]>([]);
  const [addDid, setAddDid] = useState('');
  const [addRole, setAddRole] = useState('member');
  const [addServiceRestricted, setAddServiceRestricted] = useState(false);
  const [addAllowedServices, setAddAllowedServices] = useState<string[]>([]);
  const [addingMember, setAddingMember] = useState(false);
  const [removingDid, setRemovingDid] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [enabledServices, setEnabledServices] = useState<string[]>([]);

  const authBase =
    typeof window !== 'undefined' ? globalThis.location.origin : (process.env.NEXT_PUBLIC_AUTH_URL ?? '');

  useEffect(() => {
    loadData();
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupDid]);

  async function loadData() {
    setLoading(true);
    try {
      const res = await fetch(
        `${authBase}/auth/api/groups/${encodeURIComponent(groupDid)}`,
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

  async function loadConfig() {
    try {
      const profileUrl =
        typeof window === 'undefined'
          ? (process.env.NEXT_PUBLIC_PROFILE_URL ?? '')
          : globalThis.location.origin;
      const res = await fetch(
        `${profileUrl}/api/forest/${encodeURIComponent(groupDid)}/config`,
        { credentials: 'include' }
      );
      if (res.ok) {
        const cfg = await res.json();
        setEnabledServices(cfg.enabledServices ?? []);
      }
    } catch {
      // ignore
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
        `${authBase}/auth/api/groups/${encodeURIComponent(groupDid)}/controllers`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            did: addDid.trim(),
            role: addRole,
            allowedServices:
              addServiceRestricted && addAllowedServices.length > 0
                ? addAllowedServices
                : null,
          }),
        }
      );
      if (res.ok) {
        setAddDid('');
        setAddRole('member');
        setAddServiceRestricted(false);
        setAddAllowedServices([]);
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
        `${authBase}/auth/api/groups/${encodeURIComponent(groupDid)}/controllers/${encodeURIComponent(controllerDid)}`,
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

  const existingDids = controllers.map((c) => c.controllerDid);

  if (loading) {
    return <div className="text-gray-400 py-8">Loading members…</div>;
  }

  return (
    <div className="space-y-6">
      {status && (
        <div
          className={`p-4 rounded-lg border ${
            status.type === 'success'
              ? 'bg-green-900/20 border-green-800 text-green-400'
              : 'bg-red-900/20 border-red-800 text-red-400'
          }`}
        >
          {status.text}
        </div>
      )}

      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-1">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">Members</h2>
          {controllers.length > 0 && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-gray-800 text-gray-400 font-mono">
              {controllers.length}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-400 mb-6">People connected to this identity.</p>

        {controllers.length === 0 ? (
          <p className="text-sm text-gray-500 mb-6">No members found.</p>
        ) : (
          <div className="space-y-2 mb-6">
            {controllers.map((ctrl) => {
              const isOwner = ctrl.role === 'owner';
              const roleStyle = ROLE_STYLES[ctrl.role] ?? ROLE_STYLES.member;
              const isRemoving = removingDid === ctrl.controllerDid;
              return (
                <div
                  key={ctrl.controllerDid}
                  className="flex items-center justify-between p-3 bg-gray-900 rounded-lg border border-gray-800"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-xl flex-shrink-0">👤</span>
                    <div className="min-w-0">
                      <p className="text-sm text-white font-medium font-mono truncate">
                        {ctrl.controllerDid.length > 32
                          ? ctrl.controllerDid.slice(0, 28) + '…'
                          : ctrl.controllerDid}
                      </p>
                      <p className="text-xs text-gray-500">
                        Added {new Date(ctrl.addedAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                    <span className={`px-2 py-0.5 text-xs rounded border capitalize ${roleStyle}`}>
                      {ctrl.role}
                    </span>
                    {ctrl.allowedServices && ctrl.allowedServices.length > 0 && (
                      <span
                        className="px-2 py-0.5 text-xs rounded border border-gray-700 text-gray-400"
                        title={ctrl.allowedServices.join(', ')}
                      >
                        {ctrl.allowedServices.length === 1
                          ? ctrl.allowedServices[0]
                          : `${ctrl.allowedServices.length} services`}
                      </span>
                    )}
                    {!isOwner && (
                      <button
                        onClick={() => handleRemoveMember(ctrl.controllerDid)}
                        disabled={isRemoving}
                        className="w-6 h-6 flex items-center justify-center rounded text-gray-600 hover:text-red-400 hover:bg-red-900/20 transition disabled:opacity-40"
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
        <form onSubmit={handleAddMember} className="space-y-3">
          <div className="flex gap-2 items-start">
            <div className="flex-1 min-w-0">
              <IdentityPicker
                onSelect={(identity) => setAddDid(identity.did)}
                placeholder="Search by handle or name…"
                excludeDids={existingDids}
              />
            </div>
            <select
              value={addRole}
              onChange={(e) => setAddRole(e.target.value)}
              className="px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-transparent shrink-0"
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
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-gray-300 transition disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              {addingMember ? 'Adding…' : 'Add'}
            </button>
          </div>

          {/* Service restrictions */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={addServiceRestricted}
                onChange={(e) => setAddServiceRestricted(e.target.checked)}
                className="accent-amber-500"
              />
              <span className="text-sm text-gray-400">Restrict to specific services</span>
            </label>
            {addServiceRestricted && (
              <div className="flex flex-wrap gap-2 pl-6">
                {(enabledServices.length > 0
                  ? enabledServices
                  : SELECTABLE_SERVICES.map((s) => s.name)
                ).map((svc) => {
                  const svcInfo = SELECTABLE_SERVICES.find((s) => s.name === svc);
                  const label = svcInfo?.label || svc;
                  const checked = addAllowedServices.includes(svc);
                  return (
                    <label
                      key={svc}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs cursor-pointer transition ${
                        checked
                          ? 'border-amber-600 bg-amber-900/20 text-amber-400'
                          : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setAddAllowedServices((prev) =>
                            checked ? prev.filter((s) => s !== svc) : [...prev, svc]
                          )
                        }
                        className="sr-only"
                      />
                      {label}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
