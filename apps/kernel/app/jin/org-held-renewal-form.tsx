'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { getActingAsHeaders } from '@imajin/ui/server';

/** No credential input: this proposes an extension over the existing sealed entry. */
export function OrgHeldRenewalForm({ orgDid, provider }: Readonly<{ orgDid: string; provider: string }>) {
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || pending || !expiresAt) return;
    const expiry = new Date(expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) { setError(true); return; }
    setBusy(true); setError(false);
    try {
      const response = await fetch('/api/vault/org-held/renew', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...getActingAsHeaders() },
        body: JSON.stringify({ orgDid, provider, expiresAt: expiry.toISOString() }),
      });
      if (!response.ok) throw new Error('Unavailable');
      setPending(true);
    } catch { setError(true); } finally { setBusy(false); }
  }
  return <section aria-label="Organization key renewal" className="space-y-4">
    <p>Owning organization: {orgDid}</p>
    <p>Provider: {provider}</p>
    <p>Extend the existing grant before the expiry sweep erases its material. No key is revealed, copied, replaced or requested.</p>
    <p>A human owner or admin must countersign this irreversible custody action in their personal /jin Inbox.</p>
    {error && <p role="alert">Renewal unavailable. Check your owner/admin identity and choose an expiry later than the existing grant. Erased or revoked grants cannot be renewed here.</p>}
    {pending ? <output className="block">Renewal proposed, not yet applied. Switch to your personal identity and <Link className="underline" href="/jin">sign the renewal in your Inbox</Link>. Then refresh the identity card to check its grade.</output>
      : <form onSubmit={event => void submit(event)} className="space-y-3">
        <label className="block"><span>New grant expiry (local time)</span>
          <input type="datetime-local" required value={expiresAt} disabled={busy}
            onChange={event => setExpiresAt(event.target.value)}
            className="block rounded border border-gray-700 bg-gray-950 p-2" />
        </label>
        <button type="submit" disabled={busy || !expiresAt || !orgDid || !provider}
          className="min-h-11 rounded border border-gray-700 px-3 py-2 disabled:opacity-40">
          {busy ? 'Proposing…' : 'Propose renewal'}
        </button>
      </form>}
    <Link className="inline-block min-h-11 py-3 underline" href="/jin">Back to identity cards</Link>
  </section>;
}
