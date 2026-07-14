'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { useIdentity } from './context/IdentityContext';
import { buildPublicUrl } from '@imajin/config';

const PROFILE_URL = buildPublicUrl('profile');
const AUTH_URL = buildPublicUrl('auth');

// ─── Types ────────────────────────────────────────────────────────────────────

type RelationshipType = 'business' | 'group' | 'person' | 'collective';

interface ContactSummary {
  did: string;
  label: string | null;
  relationshipType: RelationshipType | null;
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

interface PreviewRelease {
  status: 'released';
  data: Record<string, unknown>;
  envelope: {
    releaseId: string;
    scopeId: string;
    purpose: string;
    issuedAt: string;
    consentReference: string;
    mode: string;
  };
  preview: true;
}

interface PreviewRejection {
  status: 'rejected';
  reason: string;
  fields: string[];
  details?: string;
  preview: true;
}

type PreviewResult = PreviewRelease | PreviewRejection;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortDid(did: string): string {
  return did.length <= 30 ? did : `${did.slice(0, 20)}\u2026${did.slice(-6)}`;
}

function fmtDate(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '\u2014';
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

const RELATIONSHIP_LABELS: Record<RelationshipType, string> = {
  business: '\uD83C\uDFE2 Business',
  group: '\uD83D\uDC65 Group',
  person: '\uD83D\uDC64 Person',
  collective: '\uD83C\uDF10 Collective',
};

const RELATIONSHIP_ORDER: Array<RelationshipType | null> = [
  'business',
  'group',
  'person',
  'collective',
  null,
];

// ─── ContactDetail ────────────────────────────────────────────────────────────

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

  if (isLoading) return <div className="text-gray-500 text-sm py-4">Loading disclosures\u2026</div>;

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
                <span className="mt-0.5">{item.grant.status === 'revoked' ? '\uD83D\uDEAB' : '\u2705'}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-white">
                    {item.grant.status === 'revoked' ? 'Revoked' : 'Granted'}{' '}
                    <span className="text-amber-400">{item.grant.purpose}</span>
                    <span className="text-gray-500"> \u00b7 {item.grant.allowedFields.join(', ')}</span>
                  </div>
                  <div className="text-gray-500 text-xs">
                    {fmtDateTime(item.grant.createdAt)}
                    {item.grant.expiresAt ? ` \u00b7 expires ${fmtDate(item.grant.expiresAt)}` : ''}
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
                <span className="mt-0.5">{item.audit.status === 'RELEASED' ? '\uD83D\uDCE4' : '\u26D4'}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-white">
                    {item.audit.status === 'RELEASED' ? 'Released' : 'Denied'}{' '}
                    <span className="text-amber-400">{item.audit.purpose}</span>
                    {item.audit.fieldsReleased && item.audit.fieldsReleased.length > 0 && (
                      <span className="text-gray-500"> \u00b7 {item.audit.fieldsReleased.join(', ')}</span>
                    )}
                  </div>
                  <div className="text-gray-500 text-xs">
                    {fmtDateTime(item.audit.createdAt)}
                    {item.audit.reason ? ` \u00b7 ${item.audit.reason}` : ''}
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

// ─── ContactCard ──────────────────────────────────────────────────────────────

function ContactCard({
  contact,
  open,
  onToggle,
  onChanged,
}: Readonly<{
  contact: ContactSummary;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}>) {
  const [editing, setEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState(contact.label ?? '');
  const [typeDraft, setTypeDraft] = useState<RelationshipType | ''>(contact.relationshipType ?? '');
  const [saving, setSaving] = useState(false);

  async function saveMetadata() {
    setSaving(true);
    try {
      await fetch(`/api/broker/contacts/${encodeURIComponent(contact.did)}/metadata`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: labelDraft.trim() || null,
          relationshipType: typeDraft || null,
        }),
      });
      onChanged();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  const displayName = contact.label ?? shortDid(contact.did);
  const typeIcon =
    contact.relationshipType === 'business' ? '\uD83C\uDFE2'
    : contact.relationshipType === 'group' ? '\uD83D\uDC65'
    : contact.relationshipType === 'person' ? '\uD83D\uDC64'
    : contact.relationshipType === 'collective' ? '\uD83C\uDF10'
    : '\uD83E\uDD1D';

  return (
    <div className="p-4 bg-white/5 border border-white/10 rounded-lg">
      <div className="flex items-start gap-4">
        <button onClick={onToggle} className="flex-1 flex items-center gap-4 text-left min-w-0">
          <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-400 text-lg shrink-0">
            {typeIcon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-white truncate" title={contact.did}>{displayName}</div>
            {contact.label && (
              <div className="text-gray-600 text-xs truncate" title={contact.did}>{shortDid(contact.did)}</div>
            )}
            <div className="text-gray-500 text-xs">
              {contact.activeGrants} active
              {contact.revokedGrants > 0 ? ` \u00b7 ${contact.revokedGrants} revoked` : ''}
              {contact.lastDisclosureAt ? ` \u00b7 last ${fmtDate(contact.lastDisclosureAt)}` : ''}
            </div>
            {contact.purposes.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {contact.purposes.map((p) => (
                  <span key={p} className="px-1.5 py-0.5 text-xs rounded-full bg-white/10 text-gray-300">{p}</span>
                ))}
              </div>
            )}
          </div>
          <span className="text-gray-600 shrink-0">{open ? '\u25be' : '\u25b8'}</span>
        </button>

        {/* Edit button */}
        <button
          onClick={() => {
            setLabelDraft(contact.label ?? '');
            setTypeDraft(contact.relationshipType ?? '');
            setEditing((v) => !v);
          }}
          className="shrink-0 p-1.5 text-gray-600 hover:text-gray-300 transition text-base"
          title="Edit contact"
          aria-label="Edit contact"
        >
          \u270f\ufe0f
        </button>
      </div>

      {/* Inline edit form */}
      {editing && (
        <div className="mt-3 pt-3 border-t border-white/10 space-y-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Display name</label>
            <input
              type="text"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              placeholder={shortDid(contact.did)}
              className="w-full px-3 py-1.5 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Relationship type</label>
            <select
              value={typeDraft}
              onChange={(e) => setTypeDraft(e.target.value as RelationshipType | '')}
              className="w-full px-3 py-1.5 text-sm bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:border-amber-500/50"
            >
              <option value="">\u2014 none \u2014</option>
              <option value="business">Business</option>
              <option value="group">Group</option>
              <option value="person">Person</option>
              <option value="collective">Collective</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button
              onClick={saveMetadata}
              disabled={saving}
              className="px-3 py-1.5 text-sm bg-amber-500 hover:bg-amber-400 text-black font-medium rounded-lg transition disabled:opacity-50"
            >
              {saving ? 'Saving\u2026' : 'Save'}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="px-3 py-1.5 text-sm bg-white/5 hover:bg-white/10 text-gray-400 rounded-lg transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {open && <ContactDetail did={contact.did} onChanged={onChanged} />}
    </div>
  );
}

// ─── PreviewTab ───────────────────────────────────────────────────────────────

function PreviewTab({ contacts }: Readonly<{ contacts: ContactSummary[] }>) {
  const [selectedDid, setSelectedDid] = useState('');
  const [purpose, setPurpose] = useState('');
  const [customDid, setCustomDid] = useState('');
  const [customPurpose, setCustomPurpose] = useState('');
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveDid = selectedDid === '__custom__' ? customDid.trim() : selectedDid;
  const effectivePurpose = purpose === '__custom__' ? customPurpose.trim() : purpose;

  const contactPurposes = contacts.find((c) => c.did === effectiveDid)?.purposes ?? [];

  async function runPreview() {
    if (!effectiveDid || !effectivePurpose) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(
        `/api/broker/preview?requesterDid=${encodeURIComponent(effectiveDid)}&purpose=${encodeURIComponent(effectivePurpose)}`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult((await res.json()) as PreviewResult);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-gray-400 text-sm">
        Simulate what a specific requester would receive from the broker today, without creating an
        audit record.
      </p>

      <div className="space-y-4">
        <div>
          <label className="text-xs text-gray-400 block mb-1">Requester DID</label>
          <select
            value={selectedDid}
            onChange={(e) => { setSelectedDid(e.target.value); setPurpose(''); setResult(null); }}
            className="w-full px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:border-amber-500/50"
          >
            <option value="">\u2014 select a contact \u2014</option>
            {contacts.map((c) => (
              <option key={c.did} value={c.did}>{c.label ?? shortDid(c.did)}</option>
            ))}
            <option value="__custom__">Enter a DID manually\u2026</option>
          </select>
          {selectedDid === '__custom__' && (
            <input
              type="text"
              value={customDid}
              onChange={(e) => setCustomDid(e.target.value)}
              placeholder="did:imajin:\u2026"
              className="mt-2 w-full px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50"
            />
          )}
        </div>

        {(selectedDid || customDid) && (
          <div>
            <label className="text-xs text-gray-400 block mb-1">Purpose</label>
            <select
              value={purpose}
              onChange={(e) => { setPurpose(e.target.value); setResult(null); }}
              className="w-full px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:border-amber-500/50"
            >
              <option value="">\u2014 select a purpose \u2014</option>
              {contactPurposes.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
              <option value="__custom__">Enter a purpose manually\u2026</option>
            </select>
            {purpose === '__custom__' && (
              <input
                type="text"
                value={customPurpose}
                onChange={(e) => setCustomPurpose(e.target.value)}
                placeholder="e.g. dietary"
                className="mt-2 w-full px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50"
              />
            )}
          </div>
        )}

        <button
          onClick={runPreview}
          disabled={!effectiveDid || !effectivePurpose || loading}
          className="px-4 py-2 text-sm font-medium bg-amber-500 hover:bg-amber-400 text-black rounded-lg transition disabled:opacity-40"
        >
          {loading ? 'Previewing\u2026' : 'Preview'}
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">{error}</div>
      )}

      {result && (
        <div
          className={`p-4 rounded-lg border ${
            result.status === 'released'
              ? 'bg-green-500/5 border-green-500/20'
              : 'bg-red-500/5 border-red-500/20'
          }`}
        >
          {result.status === 'released' ? (
            <>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-lg">\u2705</span>
                <span className="text-sm font-medium text-white">Would be released</span>
                <span className="ml-auto text-xs text-gray-500">preview</span>
              </div>
              <div className="space-y-1.5 text-sm">
                <div><span className="text-gray-500">Purpose: </span><span className="text-amber-400">{result.envelope.purpose}</span></div>
                <div><span className="text-gray-500">Fields: </span><span className="text-white">{Object.keys(result.data).join(', ') || '\u2014'}</span></div>
                <div><span className="text-gray-500">Mode: </span><span className="text-white">{result.envelope.mode}</span></div>
                <div><span className="text-gray-500">Consent ref: </span><span className="text-gray-300 text-xs font-mono">{result.envelope.consentReference}</span></div>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">\u26d4</span>
                <span className="text-sm font-medium text-white">Would be rejected</span>
                <span className="ml-auto text-xs text-gray-500">preview</span>
              </div>
              <div className="text-sm text-gray-400">Reason: <span className="text-red-400">{result.reason}</span></div>
              {result.details && <div className="mt-1 text-xs text-gray-500">{result.details}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── DisclosuresPage ──────────────────────────────────────────────────────────

export default function DisclosuresPage() {
  const { isLoggedIn, loading } = useIdentity();
  const [tab, setTab] = useState<'contacts' | 'grants' | 'preview'>('contacts');
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

  // Group contacts by relationship type in display order.
  const grouped = RELATIONSHIP_ORDER.map((type) => ({
    type,
    label: type === null ? 'Other' : RELATIONSHIP_LABELS[type],
    contacts: contacts.filter((c) => c.relationshipType === type),
  })).filter((g) => g.contacts.length > 0);

  if (loading) {
    return <div className="max-w-2xl mx-auto py-16 text-center text-gray-400">Loading\u2026</div>;
  }

  if (!isLoggedIn) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <div className="text-6xl mb-6">\uD83D\uDD12</div>
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
          What you share, with whom, and when it expires. Default is closed \u2014 nothing is released without a grant.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-8 border-b border-white/10">
        {(['contacts', 'grants', 'preview'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
              tab === t ? 'border-amber-500 text-amber-400' : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            {t === 'contacts' ? 'By Contact' : t === 'grants' ? 'By Grant' : 'Preview'}
            {t === 'contacts' && contacts.length > 0 && (
              <span className="ml-2 px-1.5 py-0.5 text-xs bg-white/10 rounded-full">{contacts.length}</span>
            )}
            {t === 'grants' && grants.length > 0 && (
              <span className="ml-2 px-1.5 py-0.5 text-xs bg-white/10 rounded-full">{grants.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* By Contact — grouped by relationship type */}
      {tab === 'contacts' &&
        (contacts.length > 0 ? (
          <div className="space-y-6">
            {grouped.map(({ type, label, contacts: groupContacts }) => (
              <div key={type ?? '__other__'}>
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{label}</h2>
                <div className="space-y-3">
                  {groupContacts.map((c) => (
                    <ContactCard
                      key={c.did}
                      contact={c}
                      open={openContact === c.did}
                      onToggle={() => setOpenContact(openContact === c.did ? null : c.did)}
                      onChanged={refreshAll}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-12 bg-white/5 border border-white/10 rounded-lg">
            <div className="text-4xl mb-3">\uD83E\uDD1D</div>
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
                  <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-400 text-lg shrink-0">
                    \uD83D\uDDC2\uFE0F
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-white">{g.purpose}</div>
                    <div className="text-gray-500 text-xs">
                      {g.activeContacts} active recipient{g.activeContacts === 1 ? '' : 's'}
                      {g.revokedContacts > 0 ? ` \u00b7 ${g.revokedContacts} revoked` : ''}
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
            <div className="text-4xl mb-3">\uD83D\uDDC2\uFE0F</div>
            <p className="text-gray-400">No active grants by data type.</p>
          </div>
        ))}

      {/* Preview */}
      {tab === 'preview' && <PreviewTab contacts={contacts} />}
    </div>
  );
}
