'use client';

import { useState, useEffect } from 'react';
import IdentityPicker from './IdentityPicker';
import { SERVICES } from '@imajin/config';
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

const SELECTABLE_SERVICES = SERVICES.filter(
  (s) =>
    s.visibility !== 'internal' &&
    s.category !== 'meta' &&
    s.category !== 'infrastructure' &&
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
}: Readonly<{ selected: string[]; onToggle: (service: string) => void }>) {
  return (
    <div className="space-y-2 rounded-lg border border-violet-900/50 bg-violet-950/10 p-3">
      <p className="text-sm text-gray-300">Restrict to specific services</p>
      <p className="text-xs text-gray-500">
        {selected.length === 0
          ? 'No services selected — this agent may act across every service.'
          : `This agent may only act on: ${selected.join(', ')}.`}
      </p>
      <div className="flex flex-wrap gap-2">
        {SELECTABLE_SERVICES.map(({ name: svc, label }) => {
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

export default function IdentityMembersPanel({ groupDid }: Readonly<{ groupDid: string }>) {
  const [loading, setLoading] = useState(true);
  const [controllers, setControllers] = useState<Controller[]>([]);
  const [addDid, setAddDid] = useState('');
  const [addRole, setAddRole] = useState('member');
  const [addAllowedServices, setAddAllowedServices] = useState<string[]>([]);
  const [addingMember, setAddingMember] = useState(false);
  const [removingDid, setRemovingDid] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const authBase =
    typeof window === 'undefined'  ? (process.env.NEXT_PUBLIC_AUTH_URL ?? '') : globalThis.location.origin;

  useEffect(() => {
    loadData();
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

  function showStatus(type: 'success' | 'error', text: string) {
    setStatus({ type, text });
    setTimeout(() => setStatus(null), 5000);
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
        <p className="text-sm text-gray-400 mb-6">People connected to this identity.</p>

        {controllers.length === 0 ? (
          <p className="text-sm text-gray-500 mb-6">No members found.</p>
        ) : (
          <div className="space-y-2 mb-6">
            {controllers.map((ctrl) => {
              const isOwner = ctrl.role === 'owner';
              const isAgent = ctrl.role === 'agent' || ctrl.subtype === 'agent';
              const roleStyle = ROLE_STYLES[ctrl.role] ?? ROLE_STYLES.member;
              const isRemoving = removingDid === ctrl.controllerDid;
              const label = memberLabel(ctrl);
              const resolved = Boolean(ctrl.name || ctrl.handle);
              return (
                <div
                  key={ctrl.controllerDid}
                  className="flex items-center justify-between p-3 bg-gray-900 rounded-lg border border-gray-800"
                >
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
                      <button type="button"
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
            <AgentServiceScope selected={addAllowedServices} onToggle={toggleService} />
          )}
        </form>
      </div>
    </div>
  );
}
