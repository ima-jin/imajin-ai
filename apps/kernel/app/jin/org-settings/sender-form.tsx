'use client';

import { useState, type FormEvent } from 'react';
import type { MailPurpose, SenderConfig } from '@/src/lib/mail/types';
import type { SenderSettings } from './page';

type Props = { ownerDid: string; appDid: string; purpose: MailPurpose; settings: SenderSettings; onSaved?: (sender: SenderConfig) => void };
const inputClass = 'mt-1 block w-full rounded bg-gray-900 p-3';
function effectiveSender({ ownerDid, appDid, purpose, settings }: Props) {
  const candidates = settings.senders.filter(sender => sender.ownerDid === ownerDid && sender.purpose === purpose);
  const app = appDid ? candidates.find(sender => sender.appDid === appDid) : undefined;
  const owner = candidates.find(sender => sender.appDid === '');
  const verified = [app, owner].find(sender => sender && settings.readiness[sender.domain] === true);
  if (!verified) return { source: 'Kernel default', address: settings.defaults[purpose] };
  return {
    source: verified.appDid ? 'App override' : 'Organization sender',
    address: `${verified.displayName} <${verified.localPart}@${verified.domain}>`,
  };
}

export function SenderForm({ ownerDid, appDid, purpose, settings, onSaved }: Readonly<Props>) {
  const initial = settings.senders.find(sender => sender.purpose === purpose && sender.appDid === appDid);
  const [domain, setDomain] = useState(initial?.domain ?? '');
  const [localPart, setLocalPart] = useState(initial?.localPart ?? purpose);
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [replyTo, setReplyTo] = useState(initial?.replyTo ?? '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const effective = effectiveSender({ ownerDid, appDid, purpose, settings });

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    setFailed(false);
    try {
      const response = await fetch(`/jin/api/orgs/${encodeURIComponent(ownerDid)}/mail-senders`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose, appDid, domain, localPart, displayName, replyTo: replyTo || null }),
      });
      if (!response.ok) throw new Error(response.status === 403 ? 'Access denied: organization admin and app ownership are required.' : 'Unable to save sender settings.');
      onSaved?.({ ownerDid, purpose, appDid, domain: domain.trim().toLowerCase(), localPart, displayName, replyTo: replyTo || null });
      setMessage('Saved. Unverified domains continue to use the fallback sender.');
    } catch (err) {
      setFailed(true);
      setMessage(err instanceof Error ? err.message : 'Unable to save sender settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3 rounded-xl border border-gray-800 p-4" aria-label={`${purpose} sender`}>
      <h2 className="text-lg font-semibold capitalize">{purpose}</h2>
      <p className="break-words text-sm text-gray-400">Kernel fallback: {settings.defaults[purpose]}</p>
      <p className="break-words text-sm text-gray-200">Effective sender (saved settings): {effective.source} — {effective.address}</p>
      <p className="text-sm text-amber-200">{settings.readiness[domain] === true ? 'Edited domain: verified for mail.' : 'Edited domain: not verified for mail.'}</p>
      <label className="block">Domain<input className={inputClass} required maxLength={253} value={domain} onChange={event => setDomain(event.target.value)} /></label>
      <label className="block">Local part<input className={inputClass} required maxLength={64} value={localPart} onChange={event => setLocalPart(event.target.value)} /></label>
      <label className="block">Display name<input className={inputClass} required maxLength={100} value={displayName} onChange={event => setDisplayName(event.target.value)} /></label>
      <label className="block">Reply-to (optional)<input className={inputClass} type="email" maxLength={254} value={replyTo} onChange={event => setReplyTo(event.target.value)} /></label>
      <button className="min-h-11 w-full rounded bg-amber-600 px-4 py-3 font-medium disabled:opacity-50" type="submit" disabled={saving}>{saving ? 'Saving…' : `Save ${purpose} sender`}</button>
      {message && <p role={failed ? 'alert' : 'status'} className={failed ? 'text-red-400' : 'text-green-400'}>{message}</p>}
    </form>
  );
}
