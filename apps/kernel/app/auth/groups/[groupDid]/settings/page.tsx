'use client';

import { useState, useEffect } from 'react';
import { SERVICES, buildPublicUrl } from '@imajin/config';

interface GroupDetails {
  groupDid: string;
  scope: string;
  name: string;
  handle: string;
  createdBy: string;
  controllers: Array<{
    controllerDid: string;
    role: string;
    addedBy: string;
    addedAt: string;
  }>;
}

interface IdentityConfig {
  enabledServices: string[];
  landingService: string | null;
  theme: Record<string, unknown>;
}

const KERNEL_SERVICES = SERVICES.filter((s) => s.category === 'kernel' && s.visibility !== 'internal');

const SELECTABLE_SERVICES = SERVICES.filter(
  (s) =>
    s.visibility !== 'internal' &&
    s.category !== 'meta' &&
    s.category !== 'infrastructure' &&
    s.category !== 'kernel'
);

const ROLE_STYLES: Record<string, string> = {
  owner: 'border-amber-600 text-amber-400 bg-amber-900/20',
  admin: 'border-blue-700 text-blue-400 bg-blue-900/20',
  maintainer: 'border-sky-700 text-sky-400 bg-sky-900/20',
  member: 'border-gray-700 text-gray-400 bg-gray-900/20',
};

const ADD_ROLES = ['admin', 'maintainer', 'member'];

function scopeIcon(scope: string): string {
  if (scope === 'community') return '🏛️';
  if (scope === 'business') return '🏢';
  if (scope === 'family') return '👨‍👩‍👦';
  if (scope === 'node') return '🖥️';
  if (scope === 'agent') return '🤖';
  if (scope === 'device') return '📱';
  return '👤';
}

export default function IdentitySettingsPage({ params }: { params: { groupDid: string } }) {
  const groupDid = decodeURIComponent(params.groupDid);
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState<GroupDetails | null>(null);
  const [enabledServices, setEnabledServices] = useState<string[]>([]);
  const [landingService, setLandingService] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Add member form state
  const [addDid, setAddDid] = useState('');
  const [addRole, setAddRole] = useState('member');
  const [addingMember, setAddingMember] = useState(false);
  const [removingDid, setRemovingDid] = useState<string | null>(null);

  const authUrl = typeof window !== 'undefined'
    ? window.location.origin
    : (process.env.NEXT_PUBLIC_AUTH_URL ?? '');
  const profileUrl = buildPublicUrl('profile');
  const [copyLabel, setCopyLabel] = useState('Copy');

  const onboardUrl = `${authUrl}/onboard?scope=${encodeURIComponent(groupDid)}`;

  useEffect(() => {
    loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupDid]);

  async function loadData() {
    setLoading(true);
    try {
      const [groupRes, configRes] = await Promise.all([
        fetch(`${authUrl}/api/groups/${encodeURIComponent(groupDid)}`, { credentials: 'include' }),
        fetch(`${profileUrl}/api/forest/${encodeURIComponent(groupDid)}/config`, { credentials: 'include' }),
      ]);

      if (groupRes.ok) {
        setGroup(await groupRes.json());
      }
      if (configRes.ok) {
        const cfg: IdentityConfig = await configRes.json();
        setEnabledServices(cfg.enabledServices ?? []);
        setLandingService(cfg.landingService ?? null);
      }
    } catch (err) {
      console.error('Failed to load identity settings:', err);
    } finally {
      setLoading(false);
    }
  }

  function toggleService(name: string) {
    setEnabledServices(prev => {
      const next = prev.includes(name) ? prev.filter(s => s !== name) : [...prev, name];
      if (landingService && !next.includes(landingService)) {
        setLandingService(null);
      }
      return next;
    });
  }

  function showStatus(type: 'success' | 'error', text: string) {
    setStatus({ type, text });
    setTimeout(() => setStatus(null), 5000);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`${profileUrl}/api/forest/${encodeURIComponent(groupDid)}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabledServices, landingService }),
      });
      if (res.ok) {
        showStatus('success', 'Settings saved.');
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus('error', body.error || 'Failed to save settings.');
      }
    } catch {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault();
    if (!addDid.trim()) return;
    setAddingMember(true);
    try {
      const res = await fetch(`${authUrl}/api/groups/${encodeURIComponent(groupDid)}/controllers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ did: addDid.trim(), role: addRole }),
      });
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
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="text-gray-400">Loading settings…</div>
      </div>
    );
  }

  const enabledServiceOptions = SELECTABLE_SERVICES.filter(s => enabledServices.includes(s.name));
  const ownerDid = group?.controllers.find(c => c.role === 'owner')?.controllerDid;

  return (
    <div className="min-h-screen bg-[#0a0a0a] p-4 md:p-8">
      <div className="max-w-3xl mx-auto space-y-8">

        {/* Back link */}
        <a
          href={`${authUrl}/groups`}
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-300 transition no-underline"
        >
          ← Back to identities
        </a>

        {/* Header */}
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">
              {group ? (group.name || group.handle || groupDid.slice(0, 16)) : groupDid.slice(0, 16)}
            </h1>
            {group && (
              <span className="px-2 py-0.5 text-xs rounded-full border border-gray-700 text-gray-400 capitalize">
                {scopeIcon(group.scope)} {group.scope}
              </span>
            )}
          </div>
          {group?.handle && (
            <p className="text-gray-500 text-sm mt-1">@{group.handle}</p>
          )}
        </div>

        {/* Status message */}
        {status && (
          <div className={`p-4 rounded-lg border ${status.type === 'success' ? 'bg-green-900/20 border-green-800 text-green-400' : 'bg-red-900/20 border-red-800 text-red-400'}`}>
            {status.text}
          </div>
        )}

        {/* Included (kernel) services — non-interactive */}
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">Included with every identity</h2>
          <p className="text-sm text-gray-400 mb-6">These core services are always available and cannot be disabled.</p>

          <div className="flex flex-wrap gap-2">
            {KERNEL_SERVICES.map(svc => (
              <span
                key={svc.name}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-800 bg-gray-900/50 text-gray-500 text-sm"
              >
                <span>{svc.icon}</span>
                <span>{svc.label}</span>
              </span>
            ))}
          </div>
        </div>

        {/* Selectable services */}
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">Available Apps</h2>
          <p className="text-sm text-gray-400 mb-6">Toggle which apps are available for this identity.</p>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {SELECTABLE_SERVICES.map(svc => {
              const isEnabled = enabledServices.includes(svc.name);
              return (
                <button
                  key={svc.name}
                  onClick={() => toggleService(svc.name)}
                  className={`flex flex-col items-start gap-1 p-3 rounded-xl border transition text-left ${
                    isEnabled
                      ? 'border-amber-500/60 bg-amber-500/10 text-white'
                      : 'border-gray-800 bg-gray-900/30 text-gray-500 hover:border-gray-700 hover:text-gray-400'
                  }`}
                >
                  <span className="text-xl">{svc.icon}</span>
                  <span className="text-sm font-medium leading-tight">{svc.label}</span>
                  <span className={`text-xs leading-tight ${isEnabled ? 'text-amber-400/70' : 'text-gray-600'}`}>
                    {isEnabled ? 'Enabled' : 'Disabled'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Landing page section */}
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">Landing Page</h2>
          <p className="text-sm text-gray-400 mb-6">Choose which app loads first for this identity.</p>

          <select
            value={landingService ?? ''}
            onChange={e => setLandingService(e.target.value || null)}
            className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-amber-500 focus:border-transparent"
          >
            <option value="">— Default (no preference) —</option>
            {enabledServiceOptions.map(svc => (
              <option key={svc.name} value={svc.name}>
                {svc.icon} {svc.label}
              </option>
            ))}
          </select>
          {enabledServiceOptions.length === 0 && (
            <p className="text-xs text-gray-600 mt-2">Enable at least one app to set a landing page.</p>
          )}
        </div>

        {/* Onboarding section */}
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">Onboarding</h2>
          <p className="text-sm text-gray-400 mb-6">Share this link to invite people to this identity.</p>

          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-gray-300 font-mono overflow-x-auto whitespace-nowrap">
              {onboardUrl}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(onboardUrl).then(() => {
                  setCopyLabel('Copied!');
                  setTimeout(() => setCopyLabel('Copy'), 2000);
                });
              }}
              className="px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-gray-300 transition whitespace-nowrap"
            >
              {copyLabel}
            </button>
          </div>
        </div>

        {/* Members section */}
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <div className="flex items-center gap-3 mb-1">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">Members</h2>
            {group?.controllers?.length ? (
              <span className="px-1.5 py-0.5 text-xs rounded bg-gray-800 text-gray-400 font-mono">
                {group.controllers.length}
              </span>
            ) : null}
          </div>
          <p className="text-sm text-gray-400 mb-6">People who can manage this identity.</p>

          {!group?.controllers?.length ? (
            <p className="text-sm text-gray-500 mb-6">No members found.</p>
          ) : (
            <div className="space-y-2 mb-6">
              {group.controllers.map(ctrl => {
                const isOwner = ctrl.role === 'owner';
                const roleStyle = ROLE_STYLES[ctrl.role] ?? ROLE_STYLES.member;
                const isRemoving = removingDid === ctrl.controllerDid;
                return (
                  <div key={ctrl.controllerDid} className="flex items-center justify-between p-3 bg-gray-900 rounded-lg border border-gray-800">
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
          <form onSubmit={handleAddMember} className="flex gap-2">
            <input
              type="text"
              value={addDid}
              onChange={e => setAddDid(e.target.value)}
              placeholder="DID or handle"
              className="flex-1 px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-transparent"
            />
            <select
              value={addRole}
              onChange={e => setAddRole(e.target.value)}
              className="px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-transparent"
            >
              {ADD_ROLES.map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <button
              type="submit"
              disabled={addingMember || !addDid.trim()}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-gray-300 transition disabled:opacity-40 whitespace-nowrap"
            >
              {addingMember ? 'Adding…' : 'Add'}
            </button>
          </form>
        </div>

        {/* Save button */}
        <div className="flex justify-end pb-8">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2.5 bg-amber-500 hover:bg-amber-400 text-gray-950 font-semibold rounded-lg transition disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>

      </div>
    </div>
  );
}
