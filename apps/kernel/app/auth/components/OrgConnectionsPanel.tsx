'use client';

import { useCallback, useEffect, useState } from 'react';

export interface OrgConnectionsData {
  connections: { id: string; memberDid: string; provider: string; slot: string; status: string }[];
  suspensions: { orgDid: string; memberDid: string; provider: string; slot: string; suspendedAt: string | null }[];
  events: { id: string; memberDid: string | null; provider: string; actorDid: string; action: string; reason: string; createdAt: string }[];
}
const endpoint = '/auth/api/org-connections';

export default function OrgConnectionsPanel({ groupDid }: Readonly<{ groupDid: string }>) {
  const [data, setData] = useState<OrgConnectionsData | null>(null);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [provider, setProvider] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 403 ? '403: Organization admin access required.' : 'Unable to load organization connections.');
      setData(await response.json());
    } catch (err) { setData(null); setError(err instanceof Error ? err.message : 'Unable to load connections.'); }
  }, []);
  useEffect(() => { setData(null); setError(''); void load(); }, [groupDid, load]);

  async function change(target: { connectionId: string } | { provider: string }, suspended: boolean) {
    setBusy(true); setError('');
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...target, action: suspended ? 'resume' : 'suspend', reason }),
      });
      if (!response.ok) throw new Error(response.status === 403 ? '403: Organization admin access required.' : 'Unable to change suspension.');
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to change suspension.'); }
    finally { setBusy(false); }
  }
  const disabled = busy || !reason.trim();
  const services = [...new Set([
    ...(data?.connections.map(row => row.provider) ?? []),
    ...(data?.suspensions.filter(row => !row.memberDid).map(row => row.provider) ?? []),
  ])].sort((a, b) => a.localeCompare(b));
  const selectedProvider = provider || services[0] || '';
  const serviceSuspended = (value: string) => !!data?.suspensions.some(row => row.provider === value && !row.memberDid && row.suspendedAt);

  return <section className="mt-8 space-y-4 border border-zinc-800 bg-zinc-950 p-4" aria-label="Organization external connections">
    <h2 className="font-mono text-lg text-zinc-100">External connections</h2>
    <p className="text-sm text-zinc-400">Suspend org-tagged calls only. Members keep their keys and personal use. Service suspensions also cover future connections. Resuming a service does not clear individual suspensions.</p>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    <label className="block text-sm text-zinc-300"><span>Reason (required; never enter credentials)</span>
      <input value={reason} onChange={event => setReason(event.target.value)} maxLength={500}
        className="mt-1 block w-full border border-zinc-700 bg-zinc-900 p-2" />
    </label>
    {!data && !error && <p className="text-sm text-zinc-500">Loading connections…</p>}
    {data && <>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm text-zinc-300"><span>Service</span>
          <select className="ml-2 border border-zinc-700 bg-zinc-900 p-2" value={selectedProvider} onChange={event => setProvider(event.target.value)}>
            {services.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <button disabled={disabled || !selectedProvider} onClick={() => void change({ provider: selectedProvider }, serviceSuspended(selectedProvider))}
          className="border border-zinc-700 px-3 py-2 font-mono text-sm text-zinc-100 disabled:opacity-40">
          {serviceSuspended(selectedProvider) ? 'Resume service' : 'Suspend service'}
        </button>
      </div>
      {data.connections.length === 0 && <p className="text-sm text-zinc-500">No org-tagged connections.</p>}
      <ul className="space-y-2">{data.connections.map(row => {
        const individual = data.suspensions.some(item => item.memberDid === row.memberDid && item.provider === row.provider && item.slot === row.slot && item.suspendedAt);
        return <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-3 text-sm">
          <div className="min-w-0 break-all"><p className="font-mono text-zinc-100">{row.memberDid}</p>
            <p className="text-zinc-400">{row.provider} · {row.slot} · {individual ? 'Individually suspended' : 'Individual access enabled'}{serviceSuspended(row.provider) ? ' · Service suspended' : ''} · {row.status}</p></div>
          <button disabled={disabled} onClick={() => void change({ connectionId: row.id }, individual)}
            className="border border-zinc-700 px-3 py-2 font-mono text-zinc-100 disabled:opacity-40">{individual ? 'Resume connection' : 'Suspend connection'}</button>
        </li>;
      })}</ul>
      <details className="border-t border-zinc-800 pt-3 text-sm text-zinc-400"><summary className="cursor-pointer font-mono">Suspend/resume history (latest 100)</summary>
        <ul className="mt-2 space-y-2">{data.events.map(event => <li key={event.id} className="break-all">
          {event.createdAt} · {event.action} · {event.memberDid ?? 'All members'} · {event.provider} · by {event.actorDid} · {event.reason}
        </li>)}</ul>
      </details>
    </>}
  </section>;
}
