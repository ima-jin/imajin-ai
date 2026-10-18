'use client';

import { useEffect, useState } from 'react';
import { MAIL_PURPOSES, type MailPurpose, type SenderConfig } from '@/src/lib/mail/types';
import { SenderForm } from './sender-form';

type Group = { groupDid: string; role: string; scope: string; name: string | null; handle: string | null };
export type SenderSettings = {
  senders: SenderConfig[];
  defaults: Record<MailPurpose, string>;
  readiness: Record<string, boolean>;
};

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 403 ? 'Access denied' : 'Unable to load settings. Sign in and try again.');
  return response.json();
}

export default function OrgSettingsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [ownerDid, setOwnerDid] = useState('');
  const [appDid, setAppDid] = useState('');
  const [settings, setSettings] = useState<(SenderSettings & { ownerDid: string }) | null>(null);
  const [error, setError] = useState('');
  const [loadingGroups, setLoadingGroups] = useState(true);
  function rememberSender(sender: SenderConfig) {
    setSettings(current => current && current.ownerDid === sender.ownerDid ? ({
      ...current,
      senders: [...current.senders.filter(existing =>
        existing.purpose !== sender.purpose || existing.appDid !== sender.appDid), sender],
    }) : current);
  }

  useEffect(() => {
    let active = true;
    readJson<Group[]>('/auth/api/groups').then(rows => {
      if (!active) return;
      const controlled = rows.filter(row => ['owner', 'admin'].includes(row.role)
        && ['business', 'community', 'family'].includes(row.scope));
      setGroups(controlled);
      setOwnerDid(controlled[0]?.groupDid ?? '');
    }).catch(() => { if (active) setError('Unable to load organizations. Sign in and try again.'); })
      .finally(() => { if (active) setLoadingGroups(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!ownerDid) return;
    let active = true;
    setSettings(null);
    setError('');
    readJson<SenderSettings>(`/jin/api/orgs/${encodeURIComponent(ownerDid)}/mail-senders`)
      .then(data => { if (active) setSettings({ ...data, ownerDid }); })
      .catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [ownerDid]);

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-gray-100 px-4 py-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <a className="text-amber-400 underline" href="/jin">Back to /jin</a>
        <h1 className="text-2xl font-semibold">Organization mail senders</h1>
        <p className="text-sm text-gray-400">Configure send-only addresses for the four kernel purposes. This does not create mailboxes or change DNS.</p>
        <p className="rounded border border-amber-800 p-3 text-sm text-amber-200">
          Until domain ownership and mail verification are complete, messages use the imajin.ai fallback sender. Saving an address does not verify it.
        </p>
        {error && <p role="alert" className="text-red-400">{error}</p>}
        {loadingGroups && <p role="status">Loading organizations…</p>}
        {!loadingGroups && groups.length === 0 && <p>No organizations you own or administer are available.</p>}
        {groups.length > 0 && (
          <label className="block">Organization
            <select className="mt-1 block w-full rounded bg-gray-900 p-3" value={ownerDid} onChange={event => { setOwnerDid(event.target.value); setAppDid(''); }}>
              {groups.map(group => <option key={group.groupDid} value={group.groupDid}>{group.name || group.handle || group.groupDid}</option>)}
            </select>
          </label>
        )}
        {settings && (
          <>
            <label className="block">App override DID (optional)
              <input className="mt-1 block w-full rounded bg-gray-900 p-3" value={appDid} onChange={event => setAppDid(event.target.value.trim())} placeholder="Leave empty for organization defaults" />
            </label>
            <p className="text-sm text-gray-400">An app override must be a registered active app owned by this organization. Without a verified override, the organization sender or kernel default is used.</p>
            {MAIL_PURPOSES.map(purpose => (
              <SenderForm key={`${ownerDid}:${appDid}:${purpose}`} ownerDid={ownerDid} appDid={appDid} purpose={purpose} settings={settings} onSaved={rememberSender} />
            ))}
          </>
        )}
      </div>
    </main>
  );
}
