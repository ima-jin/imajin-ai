'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { useIdentity } from './context/IdentityContext';
import { buildPublicUrl } from '@imajin/config';

const PROFILE_URL = buildPublicUrl('profile');
const AUTH_URL = buildPublicUrl('auth');

interface ContactSummary {
  did: string;
  activeGrants: number;
  revokedGrants: number;
  purposes: string[];
  lastDisclosureAt: string | null;
}

interface GrantSummary {
  purpose: string;
  fields: string[];
  activeContacts: number;
  revokedContacts: number;
  contacts: string[];
}

interface ConsentGrant {
  id: string;
  grantedTo: string | null;
  purpose: string;
  allowedFields: string[];
  status: string;
  expiresAt: string | null;
  createdAt: string;
}

interface AuditEntry {
  id: string;
  type: string;
  requester: string;
  purpose: string;
  fieldsReleased: string[] | null;
  status: string;
  reason: string | null;
  createdAt: string;
}

function shortDid(did: string): string {
  return did.length <= 30 ? did : `${did.slice(0, 20)}…${did.slice(-6)}`;
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function revokeGrant(id: string): Promise<void> {
  await fetch(`/api/broker/consent/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function revokeAll(filter: { grantedTo?: string; purpose?: string }): Promise<void> {
  await fetch('/api/broker/consent/revoke-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filter),
  });
}

type TimelineItem =
  | { key: string; at: string; kind: 'grant'; grant: ConsentGrant }
  | { key: string; at: string; kind: 'audit'; audit: AuditEntry };

function ContactDetail({ did, onChanged }: Readonly<{ did: string; onChanged: () => void }>) {
  const { data, isLoading, mutate } = useSWR<{ did: string; grants: ConsentGrant[]; audit: AuditEntry[] }>(
    `/api/broker/contacts/${encodeURIComponent(did)}/disclosures`,
  );
  const [busy, setBusy] = useState(false);

  const grants = data?.grants ?? [];
  const audit = data?.audit ?? [];
  const activeCount = grants.filter((g) => g.status === 'active').length;

  async function onRevokeGrant(id: string) {
    setBusy(true);
    try {
      await revokeGrant(id);
      await mutate();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function onRevokeAll() {
    setBusy(true);
    try {
      await revokeAll({ grantedTo: did });
      await mutate();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const timeline: TimelineItem[] = [
    ...grants.map((g): TimelineItem => ({ key: `g:${g.id}`, at: g.createdAt, kind: 'grant', grant: g })),
    ...audit.map((a): TimelineItem => ({ key: `a:${a.id}`, at: a.createdAt, kind: 'audit', audit: a })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  if (isLoading) return <div className="text-gray-500 text-sm py-4">Loading disclosures…</div>;

  return (
    <div className="mt-3 border-t border-white/10 pt-4">
      {activeCount > 0 && (
        <div className="flex justify-end mb-3">
          <button
            onClick={onRevokeAll}
            disabled={busy}
            className="px-3 py-1.5 text-sm bg-white/5 hover:bg-red-500/20 text-gray-400 hover:text-red-400 rounded-lg transition disabled:opacity-50"
          >
            Revoke all ({activeCount})
          </button>
        </div>
      )}

      {timeline.length === 0 ? (
        <div className="text-gray-500 text-sm py-2">No disclosures or grants yet.</div>
      ) : (
        <ul className="space-y-2">
          {timeline.map((item) =>
            item.kind === 'grant' ? (
              <li key={item.key} className="flex items-start gap-3 text-sm">
                <span className="mt-0.5">{item.grant.status === 'revoked' ? '🚫' : '✅'}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-white">
                    {item.grant.status === 'revoked' ? 'Revoked' : 'Granted'}{' '}
                    <span className="text-amber-400">{item.grant.purpose}</span>
                    <span className="text-gray-500"> · {item.grant.allowedFields.join(', ')}</span>
                  </div>
                  <div className="text-gray-500 text-xs">
                    {fmtDateTime(item.grant.createdAt)}
                    {item.grant.expiresAt ? ` · expires ${fmtDate(item.grant.expiresAt)}` : ''}
                  </div>
                </div>
                {item.grant.status === 'active' && (
                  <button
                    onClick={() => onRevokeGrant(item.grant.id)}
                    disabled={busy}
                    className="px-2 py-1 text-xs bg-white/5 hover:bg-red-500/20 text-gray-500 hover:text-red-400 rounded transition disabled:opacity-50 shrink-0"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ) : (
              <li key={item.key} className="flex items-start gap-3 text-sm">
                <span className="mt-0.5">{item.audit.status === 'RELEASED' ? '📤' : '⛔'}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-white">
                    {item.audit.status === 'RELEASED' ? 'Released' : 'Denied'}{' '}
                    <span className="text-amber-400">{item.audit.purpose}</span>
                    {item.audit.fieldsReleased && item.audit.fieldsReleased.length > 0 && (
                      <span className="text-gray-500"> · {item.audit.fieldsReleased.join(', ')}</span>
                    )}
                  </div>
                  <div className="text-gray-500 text-xs">
                    {fmtDateTime(item.audit.createdAt)}
                    {item.audit.reason ? ` · ${item.audit.reason}` : ''}
                  </div>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

export default function DisclosuresPage() {
  const { isLoggedIn, loading } = useIdentity();
  const [tab, setTab] = useState<'contacts' | 'grants'>('contacts');
  const [openContact, setOpenContact] = useState<string | null>(null);

  const { data: contactsData, mutate: mutateContacts } = useSWR<{ contacts: ContactSummary[] }>(
    isLoggedIn ? '/api/broker/contacts' : null,
  );
  const { data: grantsData, mutate: mutateGrants } = useSWR<{ grants: GrantSummary[] }>(
    isLoggedIn ? '/api/broker/grants' : null,
  );
  const contacts = contactsData?.contacts ?? [];
  const grants = grantsData?.grants ?? [];

  function refreshAll() {
    mutateContacts();
    mutateGrants();
  }

  async function onRevokeDataType(purpose: string) {
    await revokeAll({ purpose });
    refreshAll();
  }

  if (loading) {
    return <div className="max-w-2xl mx-auto py-16 text-center text-gray-400">Loading…</div>;
  }

  if (!isLoggedIn) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <div className="text-6xl mb-6">🔒</div>
        <h1 className="text-3xl font-bold mb-3">Your disclosures</h1>
        <p className="text-gray-400 mb-8">Sign in to see what you&apos;ve shared, with whom, and when it expires.</p>
        <a
          href={`${PROFILE_URL}/login?next=${encodeURIComponent(AUTH_URL)}`}
          className="inline-block px-8 py-3 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg transition"
        >
          Sign In
        </a>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Disclosures</h1>
        <p className="text-gray-400 text-sm mt-1">
          What you share, with whom, and when it expires. Default is closed — nothing is released without a grant.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-8 border-b border-white/10">
        <button
          onClick={() => setTab('contacts')}
          className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
            tab === 'contacts' ? 'border-amber-500 text-amber-400' : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          By Contact
          {contacts.length > 0 && <span className="ml-2 px-1.5 py-0.5 text-xs bg-white/10 rounded-full">{contacts.length}</span>}
        </button>
        <button
          onClick={() => setTab('grants')}
          className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
            tab === 'grants' ? 'border-amber-500 text-amber-400' : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          By Grant
          {grants.length > 0 && <span className="ml-2 px-1.5 py-0.5 text-xs bg-white/10 rounded-full">{grants.length}</span>}
        </button>
      </div>

      {/* By Contact */}
      {tab === 'contacts' &&
        (contacts.length > 0 ? (
          <div className="space-y-3">
            {contacts.map((c) => {
              const open = openContact === c.did;
              return (
                <div key={c.did} className="p-4 bg-white/5 border border-white/10 rounded-lg">
                  <button onClick={() => setOpenContact(open ? null : c.did)} className="w-full flex items-center gap-4 text-left">
                    <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-400 text-lg shrink-0">🏢</div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-white truncate" title={c.did}>{shortDid(c.did)}</div>
                      <div className="text-gray-500 text-xs">
                        {c.activeGrants} active{c.revokedGrants > 0 ? ` · ${c.revokedGrants} revoked` : ''} · last {fmtDate(c.lastDisclosureAt)}
                      </div>
                      {c.purposes.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {c.purposes.map((p) => (
                            <span key={p} className="px-1.5 py-0.5 text-xs rounded-full bg-white/10 text-gray-300">{p}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <span className="text-gray-600 shrink-0">{open ? '▾' : '▸'}</span>
                  </button>
                  {open && <ContactDetail did={c.did} onChanged={refreshAll} />}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-12 bg-white/5 border border-white/10 rounded-lg">
            <div className="text-4xl mb-3">🤝</div>
            <p className="text-gray-400">You haven&apos;t shared anything yet.</p>
          </div>
        ))}

      {/* By Grant */}
      {tab === 'grants' &&
        (grants.length > 0 ? (
          <div className="space-y-3">
            {grants.map((g) => (
              <div key={g.purpose} className="p-4 bg-white/5 border border-white/10 rounded-lg">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-400 text-lg shrink-0">🗂️</div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-white">{g.purpose}</div>
                    <div className="text-gray-500 text-xs">
                      {g.activeContacts} active recipient{g.activeContacts === 1 ? '' : 's'}
                      {g.revokedContacts > 0 ? ` · ${g.revokedContacts} revoked` : ''}
                    </div>
                    {g.fields.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {g.fields.map((f) => (
                          <span key={f} className="px-1.5 py-0.5 text-xs rounded-full bg-white/10 text-gray-300">{f}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  {g.activeContacts > 0 && (
                    <button
                      onClick={() => onRevokeDataType(g.purpose)}
                      className="px-2 py-1 text-xs bg-white/5 hover:bg-red-500/20 text-gray-500 hover:text-red-400 rounded transition shrink-0"
                    >
                      Revoke all
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-12 bg-white/5 border border-white/10 rounded-lg">
            <div className="text-4xl mb-3">🗂️</div>
            <p className="text-gray-400">No active grants by data type.</p>
          </div>
        ))}
    </div>
  );
}
