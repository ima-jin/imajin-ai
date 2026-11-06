'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ConnectorEntry } from '@/src/lib/kernel/connector-registry';
import { loadedMetadata, type LoadedKey, type Member, type OrgConnectorMode } from './ConnectorMode';

interface Grant { memberDid: string }

const buttonClass = 'rounded border border-gray-700 px-3 py-2 text-sm text-white disabled:opacity-40';
const fieldClass = 'mt-1 block w-full rounded border border-gray-700 bg-gray-950 p-2 text-white';

function actingHeaders(orgDid: string) {
  return { 'Content-Type': 'application/json', 'X-Acting-As': orgDid };
}

function KeyStatus({ uncertain, metadata }: Readonly<{ uncertain: boolean; metadata?: LoadedKey }>) {
  if (uncertain) return <output className="block text-sm text-gray-400">Key status unavailable.</output>;
  if (!metadata) return <output className="block text-sm text-gray-400">Not loaded — re-load here</output>;
  return <output className="block break-all text-sm text-green-400">
    <span className="block">Loaded</span>
    {metadata.loadedByDid && <span className="block">Loaded by {metadata.loadedByDid}</span>}
    <span className="block">Loaded at <time dateTime={metadata.loadedAt}>{metadata.loadedAt}</time></span>
  </output>;
}

function MemberGrants({ entry, orgDid, members, loaded }: Readonly<{
  entry: ConnectorEntry; orgDid: string; members: Member[]; loaded: boolean;
}>) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endpoint = `/connections/api/org-held/${entry.id}/grants`;
  const headers = actingHeaders(orgDid);

  useEffect(() => {
    const controller = new AbortController();
    fetch(endpoint, { headers: actingHeaders(orgDid), cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Member grants read failed');
        const data = await response.json();
        if (!controller.signal.aborted) setGrants(data.grants.map((grant: Grant) => ({ memberDid: grant.memberDid })));
      })
      .catch(() => { if (!controller.signal.aborted) setError('Unable to load member grants.'); });
    return () => controller.abort();
  }, [endpoint, orgDid]);

  async function change(memberDid: string, granted: boolean) {
    if (busy || !reason.trim() || reason.length > 500 || !grants) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(endpoint, {
        method: granted ? 'DELETE' : 'POST', headers, body: JSON.stringify({ memberDid, reason: reason.trim() }),
      });
      if (!response.ok) throw new Error('Member grant change failed');
      // Re-read authoritative state; a failed mutation never changes the displayed grant.
      const read = await fetch(endpoint, { headers, cache: 'no-store' });
      if (!read.ok) throw new Error('Member grants refresh failed');
      const data = await read.json();
      setGrants(data.grants.map((grant: Grant) => ({ memberDid: grant.memberDid })));
    } catch {
      setGrants(null);
      setError('Unable to update member grants. Reload to check current access.');
    } finally { setBusy(false); }
  }

  const grantedDids = new Set(grants?.map(grant => grant.memberDid));
  return <section id={`org-connector-${entry.id}-grants`} aria-label={`${entry.name} member grants`} className="space-y-3 border-t border-gray-800 pt-4">
    <h4 className="font-semibold text-white">Member grants</h4>
    <p className="text-sm text-gray-400">Human members need a specific grant to use this org key (use-case C). An agent assigned to the org uses the org&apos;s keys without a member grant.</p>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {grants === null && !error && <p className="text-sm text-gray-400">Loading member grants…</p>}
    <label className="block text-sm text-gray-300">
      <span>Grant/revoke reason (required; never enter credentials)</span>
      <input className={fieldClass} value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={busy} />
    </label>
    {members.length === 0 && <p className="text-sm text-gray-400">No human members.</p>}
    <ul className="space-y-3">{members.map(member => {
      const granted = grantedDids.has(member.controllerDid);
      const label = member.name || (member.handle ? `@${member.handle}` : member.controllerDid);
      const knownStatus = granted ? 'Granted' : 'Not granted';
      const grantStatus = grants ? knownStatus : 'Grant status unavailable';
      return <li key={member.controllerDid} className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 break-all text-sm text-gray-300">
          <p>{label}</p><p className="text-xs text-gray-500">{member.controllerDid} · {grantStatus}</p>
        </div>
        <button type="button" className={buttonClass}
          disabled={busy || !grants || !reason.trim() || reason.length > 500 || (!loaded && !granted)}
          aria-label={`${granted ? 'Revoke' : 'Grant'} ${entry.name} for ${label}`}
          onClick={() => void change(member.controllerDid, granted)}>{granted ? 'Revoke' : 'Grant'}</button>
      </li>;
    })}</ul>
  </section>;
}

export function OrgCredentialSection({ entry, mode, onReady }: Readonly<{
  entry: ConnectorEntry; mode: OrgConnectorMode; onReady: (ready: boolean) => void;
}>) {
  const { orgDid, initial, canManage, members, statusUnavailable } = mode;
  const [metadata, setMetadata] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(statusUnavailable);
  const input = useRef<HTMLInputElement>(null);
  const endpoint = `/connections/api/org-held/${entry.id}`;
  useEffect(() => { onReady(!!metadata && !uncertain); }, [metadata, uncertain, onReady]);

  async function change(method: 'POST' | 'DELETE', event?: FormEvent) {
    event?.preventDefault();
    if (!canManage || busy) return;
    if (method === 'POST' && (!input.current || !/^[\x21-\x7e]{1,4096}$/.test(input.current.value))) {
      setError('Enter a service key of 1–4096 printable ASCII characters without spaces.');
      return;
    }
    setBusy(true); setError('');
    try {
      // No React state contains the key. Clear the uncontrolled field as soon as
      // fetch owns the request, including rejected requests. Never render errors
      // from the response: a server/proxy error must not echo submitted input.
      let request: Promise<Response>;
      try {
        request = fetch(endpoint, {
          method, headers: actingHeaders(orgDid),
          ...(method === 'POST' ? { body: JSON.stringify({ secret: input.current?.value }) } : {}),
        });
      } finally { if (input.current) input.current.value = ''; }
      const response = await request;
      if (!response.ok) throw new Error('Org service key change failed');
      if (method === 'POST') {
        const data: LoadedKey = await response.json();
        if (!data.loadedByDid || !data.loadedAt) throw new Error('Load record missing');
        setMetadata(loadedMetadata(data));
      }
      else setMetadata(undefined);
      setUncertain(false);
    } catch {
      setUncertain(true);
      setError('Unable to change org service key. Reload to check current status.');
    } finally { setBusy(false); }
  }

  return <section className="space-y-4" aria-label={`${entry.name} org custody`}>
    <p className="text-sm text-gray-400">Org-held {entry.name} service key, sealed under this org&apos;s DID.</p>
    <KeyStatus uncertain={uncertain} metadata={metadata} />
    {!canManage && <p className="text-sm text-gray-400">Read-only</p>}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {canManage && <>
      <form onSubmit={event => void change('POST', event)} className="space-y-3">
        <label className="block text-sm text-gray-300">
          <span>{metadata ? 'Replacement service key' : 'Service key'} (write-only)</span>
          <input ref={input} type="password" autoComplete="new-password" required maxLength={4096} disabled={busy} className={fieldClass} />
        </label>
        <p className="text-xs text-gray-500">Sealed for this org. The value is cleared on submit and never shown again.</p>
        <button className={buttonClass} type="submit" disabled={busy}>{metadata ? 'Replace key' : 'Load key'}</button>
        {metadata && <button className={`${buttonClass} ml-2`} type="button" disabled={busy} onClick={() => void change('DELETE')}>Remove key</button>}
      </form>
      <MemberGrants entry={entry} orgDid={orgDid} members={members} loaded={!!metadata && !uncertain} />
    </>}
  </section>;
}

