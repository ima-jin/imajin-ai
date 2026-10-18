'use client';

import { useState, useEffect } from 'react';
import IdentityPicker from './IdentityPicker';
import { SERVICES } from '@imajin/config';
import { setActingAs } from '@imajin/ui/server';
import { loadRegistryAppOptions } from '@/src/lib/profile/app-options';
import {
  ASSIGNABLE_MEMBER_ROLES,
  MEMBER_ADDED_VIA_DESCRIPTIONS,
  MEMBER_ADDED_VIA_LABELS,
  type MemberAddedVia,
} from '@/src/lib/auth/membership';

interface Controller {
  controllerDid: string;
  role: string;
  addedBy: string | null;
  addedVia: MemberAddedVia | null;
  addedAt: string;
  allowedServices: string[] | null;
  /** Resolved from auth.identities by the groups endpoint — null if unknown. */
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  subtype: string | null;
  addedByName: string | null;
  addedByHandle: string | null;
}

const ROLE_STYLES: Record<string, string> = {
  owner: 'border-amber-600 text-amber-400 bg-amber-900/20',
  admin: 'border-blue-700 text-blue-400 bg-blue-900/20',
  maintainer: 'border-sky-700 text-sky-400 bg-sky-900/20',
  member: 'border-gray-700 text-gray-400 bg-gray-900/20',
  agent: 'border-violet-700 text-violet-400 bg-violet-900/20',
};

const ROLE_HINTS: Record<string, string> = {
  admin: 'Full control except ownership transfer',
  maintainer: 'Can manage content, not members',
  member: 'Read access to member-only content',
  agent: 'Can act for this identity via X-Acting-For delegation',
};

/**
 * Services an agent's `allowed_services` can be scoped to.
 *
 * This is the set the X-Acting-For check can actually gate on, so it includes
 * the kernel-hosted services an agent is most often delegated for (media, chat,
 * pay, connections) and excludes the platform surfaces that have no
 * per-identity delegation to restrict (the launcher, auth itself, the registry,
 * internal daemons and meta links).
 */
const PLATFORM_ONLY_SERVICES = new Set(['kernel', 'auth', 'registry']);

const KERNEL_SERVICES = SERVICES.filter(
  (s) =>
    s.category === 'kernel' &&
    s.visibility !== 'internal' &&
    !PLATFORM_ONLY_SERVICES.has(s.name)
);

function truncateDid(did: string): string {
  return did.length > 32 ? did.slice(0, 28) + '…' : did;
}

/** "Ryan Veteze (@veteze)", falling back through handle, then a short DID. */
function memberLabel(ctrl: Pick<Controller, 'controllerDid' | 'name' | 'handle'>): string {
  if (ctrl.name && ctrl.handle) return `${ctrl.name} (@${ctrl.handle})`;
  if (ctrl.name) return ctrl.name;
  if (ctrl.handle) return `@${ctrl.handle}`;
  return truncateDid(ctrl.controllerDid);
}

function adderLabel(ctrl: Controller): string | null {
  if (ctrl.addedByName && ctrl.addedByHandle) return `${ctrl.addedByName} (@${ctrl.addedByHandle})`;
  if (ctrl.addedByName) return ctrl.addedByName;
  if (ctrl.addedByHandle) return `@${ctrl.addedByHandle}`;
  if (ctrl.addedBy) return truncateDid(ctrl.addedBy);
  return null;
}

function formatAddedAt(addedAt: string): string | null {
  const date = new Date(addedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Added by Ryan (@veteze) · direct · Aug 7, 2026" — omits parts we cannot resolve. */
function provenanceParts(ctrl: Controller): string[] {
  const parts: string[] = [];
  const adder = adderLabel(ctrl);
  parts.push(adder ? `Added by ${adder}` : 'Added');
  if (ctrl.addedVia) parts.push(MEMBER_ADDED_VIA_LABELS[ctrl.addedVia]);
  const when = formatAddedAt(ctrl.addedAt);
  if (when) parts.push(when);
  return parts;
}

/**
 * Service multi-select for a delegated agent.
 *
 * An empty selection is full access, not "no access" — `allowed_services` is a
 * narrowing list, and the delegation check skips it when it is null.
 */
function AgentServiceScope({
  selected,
  onToggle,
  services,
}: Readonly<{ selected: string[]; onToggle: (service: string) => void; services: { name: string; label: string }[] }>) {
  return (
    <div className="space-y-2 rounded-lg border border-violet-900/50 bg-violet-950/10 p-3">
      <p className="text-sm text-gray-300">Restrict to specific services</p>
      <p className="text-xs text-gray-500">
        {selected.length === 0
          ? 'No services selected — this agent may act across every service.'
          : `This agent may only act on: ${selected.join(', ')}.`}
      </p>
      <div className="flex flex-wrap gap-2">
        {services.map(({ name: svc, label }) => {
          const checked = selected.includes(svc);
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
                onChange={() => onToggle(svc)}
                className="sr-only"
              />
              {label}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function MemberEditor({
  controller,
  endpoint,
  viewerRole,
  services,
  onCancel,
  onSaved,
}: Readonly<{
  controller: Controller;
  endpoint: string;
  viewerRole: string | null;
  services: { name: string; label: string }[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}>) {
  const [role, setRole] = useState(controller.role);
  const [selected, setSelected] = useState(controller.allowedServices ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roles = ASSIGNABLE_MEMBER_ROLES.filter((value) => value !== 'admin' || viewerRole === 'owner');

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving || (role === 'admin' && viewerRole !== 'owner')) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role,
          allowedServices: role === 'agent' && selected.length > 0 ? selected : null,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error || 'Failed to update member.');
        return;
      }
      await onSaved();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} aria-label={`Edit ${memberLabel(controller)}`} className="mt-3">
      <fieldset disabled={saving} className="space-y-3">
        <label className="block text-sm text-gray-300">
          <span>Member role</span>
          <select
            value={role}
            onChange={(event) => setRole(event.target.value)}
            className="ml-3 px-3 py-2 bg-gray-950 border border-gray-700 rounded-lg text-sm text-white [color-scheme:dark]"
          >
            {controller.role === 'admin' && viewerRole !== 'owner' && (
              <option value="admin" disabled>admin (choose a new role)</option>
            )}
            {roles.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        {ROLE_HINTS[role] && <p className="text-xs text-gray-500">{ROLE_HINTS[role]}</p>}
        {role === 'agent' && (
          <AgentServiceScope selected={selected} services={services} onToggle={(service) => {
            setSelected((previous) => previous.includes(service)
              ? previous.filter((value) => value !== service)
              : [...previous, service]);
          }} />
        )}
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button type="submit" disabled={role === 'admin' && viewerRole !== 'owner'} className="px-3 py-1.5 rounded-lg bg-amber-500 text-black text-sm disabled:opacity-40">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 text-sm disabled:opacity-40">
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}

export default function IdentityMembersPanel({ groupDid, scope }: Readonly<{ groupDid: string; scope: string }>) {
  const [loading, setLoading] = useState(true);
  const [appServices, setAppServices] = useState<{ name: string; label: string }[]>([]);
  const [controllers, setControllers] = useState<Controller[]>([]);
  const [viewerRole, setViewerRole] = useState<string | null>(null);
  const [viewerDid, setViewerDid] = useState<string | null>(null);
  const [editingDid, setEditingDid] = useState<string | null>(null);
  const [addDid, setAddDid] = useState('');
  const [addRole, setAddRole] = useState('member');
  const [addAllowedServices, setAddAllowedServices] = useState<string[]>([]);
  const [addingMember, setAddingMember] = useState(false);
  const [removingDid, setRemovingDid] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const authBase =
    typeof window === 'undefined'  ? (process.env.NEXT_PUBLIC_AUTH_URL ?? '') : globalThis.location.origin;

  useEffect(() => {
    setEditingDid(null);
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupDid]);
  useEffect(() => {
    if (!status) return;
    const timeout = setTimeout(() => setStatus(null), 5000);
    return () => clearTimeout(timeout);
  }, [status]);

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
        setViewerRole(data.viewerRole ?? null);
        setViewerDid(data.viewerDid ?? null);
      }
      setAppServices(await loadRegistryAppOptions(groupDid));
    } catch (err) {
      console.error('Failed to load members:', err);
    } finally {
      setLoading(false);
    }
  }

  function showStatus(type: 'success' | 'error', text: string) {
    setStatus({ type, text });
  }

  function toggleService(service: string) {
    setAddAllowedServices((prev) =>
      prev.includes(service) ? prev.filter((s) => s !== service) : [...prev, service]
    );
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
            // Service scoping only applies to delegated agents; the API ignores
            // it for every other role.
            allowedServices:
              addRole === 'agent' && addAllowedServices.length > 0 ? addAllowedServices : null,
          }),
        }
      );
      if (res.ok) {
        setAddDid('');
        setAddRole('member');
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
        <p className="text-sm text-gray-400 mb-2">People connected to this identity.</p>
        <p className="text-xs text-gray-500 mb-6">
          Owner roles cannot be edited here. Use the{' '}
          <a href={`/auth/groups/${encodeURIComponent(groupDid)}/ownership`} className="text-amber-400 underline">
            ownership transfer
          </a>{' '}flow to change the owner.
        </p>

        {controllers.length === 0 ? (
          <p className="text-sm text-gray-500 mb-6">No members found.</p>
        ) : (
          <div className="space-y-2 mb-6">
            {controllers.map((ctrl) => {
              const isOwner = ctrl.role === 'owner';
              const isAgent = ctrl.role === 'agent' || ctrl.subtype === 'agent';
              const roleStyle = ROLE_STYLES[ctrl.role] ?? ROLE_STYLES.member;
              const isRemoving = removingDid === ctrl.controllerDid;
              const canEdit = !isOwner && (viewerRole === 'owner'
                || (viewerRole === 'admin' && (ctrl.role === 'member' || ctrl.controllerDid === viewerDid)));
              const isEditing = editingDid === ctrl.controllerDid && canEdit;
              const label = memberLabel(ctrl);
              const resolved = Boolean(ctrl.name || ctrl.handle);
              return (
                <div
                  key={ctrl.controllerDid}
                  className="p-3 bg-gray-900 rounded-lg border border-gray-800"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                      {ctrl.avatarUrl ? (
                        <img
                          src={ctrl.avatarUrl}
                          alt=""
                          className="w-7 h-7 rounded-full object-cover flex-shrink-0 bg-gray-800"
                        />
                      ) : (
                        <span className="text-xl flex-shrink-0">{isAgent ? '🤖' : '👤'}</span>
                      )}
                      <div className="min-w-0">
                        <p
                          className={`text-sm text-white font-medium truncate ${resolved ? '' : 'font-mono'}`}
                          title={ctrl.controllerDid}
                        >
                          {label}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {provenanceParts(ctrl).map((part, i) => (
                            <span key={part}>
                              {i > 0 && <span className="text-gray-700"> · </span>}
                              <span
                                title={
                                  ctrl.addedVia && part === MEMBER_ADDED_VIA_LABELS[ctrl.addedVia]
                                    ? MEMBER_ADDED_VIA_DESCRIPTIONS[ctrl.addedVia]
                                    : undefined
                                }
                              >
                                {part}
                              </span>
                            </span>
                          ))}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 sm:ml-3">
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
                      {canEdit && (
                        <button type="button"
                          onClick={() => setEditingDid(ctrl.controllerDid)}
                          disabled={isRemoving || editingDid !== null}
                          aria-label={`Edit ${label}`}
                          className="px-2 py-1 text-xs rounded text-gray-400 hover:text-amber-400 transition disabled:opacity-40"
                        >
                          Edit
                        </button>
                      )}
                      {!isOwner && (
                        <button type="button"
                          onClick={() => handleRemoveMember(ctrl.controllerDid)}
                          disabled={isRemoving || editingDid !== null}
                          className="w-6 h-6 flex items-center justify-center rounded text-gray-600 hover:text-red-400 hover:bg-red-900/20 transition disabled:opacity-40"
                          title="Remove member"
                        >
                          {isRemoving ? '…' : '×'}
                        </button>
                      )}
                    </div>
                  </div>
                  {isEditing && (
                    <MemberEditor
                      controller={ctrl}
                      viewerRole={viewerRole}
                      endpoint={`${authBase}/auth/api/groups/${encodeURIComponent(groupDid)}/controllers/${encodeURIComponent(ctrl.controllerDid)}`}
                      services={[...KERNEL_SERVICES, ...appServices]}
                      onCancel={() => setEditingDid(null)}
                      onSaved={async () => {
                        setEditingDid(null);
                        showStatus('success', 'Member updated.');
                        await loadData();
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Add member form */}
        <form onSubmit={handleAddMember} className="space-y-3">
          {['business', 'community', 'family'].includes(scope) && (
            <p className="text-sm text-gray-400">
              Members act for this organization and can see who&apos;s inside it.
              Clients, vendors and partners should be added as a connection instead.{' '}
              <a
                href="/connections?connect=1"
                onClick={() => setActingAs(groupDid)}
                className="text-amber-400 underline hover:text-amber-300"
              >
                Add a connection
              </a>
            </p>
          )}
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
              {ASSIGNABLE_MEMBER_ROLES.map((r) => (
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

          {ROLE_HINTS[addRole] && (
            <p className="text-xs text-gray-500">{ROLE_HINTS[addRole]}</p>
          )}

          {/*
            Service scoping is only enforced for the agent role — `allowed_services`
            is checked by the X-Acting-For delegation path. Showing it for humans
            would imply a restriction the platform does not apply.
          */}
          {addRole === 'agent' && (
            <AgentServiceScope selected={addAllowedServices} onToggle={toggleService} services={[...KERNEL_SERVICES, ...appServices]} />
          )}
        </form>
      </div>
    </div>
  );
}
