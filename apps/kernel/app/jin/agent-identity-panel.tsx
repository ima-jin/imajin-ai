'use client';

import { useEffect, useState } from 'react';
import { getActingAsHeaders } from '@imajin/ui/server';
import { AgentIdentityCard, type AgentCards } from './agent-identity-card';

/** Same discovery endpoint as agents; the server authorizes the operator projection. */
export function AgentIdentityPanel() {
  const [data, setData] = useState<AgentCards | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let controller: AbortController | undefined;
    const load = async (clear = false) => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      if (clear) { setData(null); setError(false); }
      try {
        const response = await fetch('/infer/v1/self?agents=1', {
          credentials: 'include', cache: 'no-store', headers: getActingAsHeaders(), signal: current.signal,
        });
        if (current.signal.aborted) return;
        if (response.status === 401 || response.status === 403) { setData(null); setError(false); return; }
        if (!response.ok) throw new Error('Unavailable');
        const body: AgentCards = await response.json();
        if (!Array.isArray(body.cards) || typeof body.principalDid !== 'string') throw new Error('Invalid response');
        if (!current.signal.aborted) { setData(body); setError(false); }
      } catch {
        if (!current.signal.aborted) { setData(null); setError(true); }
      }
    };
    const identityChanged = () => { void load(true); };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === null || event.key === 'imajin:acting-as') identityChanged();
    };
    const refresh = () => { void load(); };
    void load(true);
    const timer = setInterval(refresh, 30_000);
    globalThis.addEventListener('imajin:session-changed', identityChanged);
    globalThis.addEventListener('imajin:acting-as-changed', identityChanged);
    globalThis.addEventListener('storage', storageChanged);
    globalThis.addEventListener('focus', refresh);
    return () => {
      controller?.abort(); clearInterval(timer);
      globalThis.removeEventListener('imajin:session-changed', identityChanged);
      globalThis.removeEventListener('imajin:acting-as-changed', identityChanged);
      globalThis.removeEventListener('storage', storageChanged);
      globalThis.removeEventListener('focus', refresh);
    };
  }, [revision]);
  if (!data && !error) return null;
  return <section aria-label="Agent identity cards" className="mb-8 space-y-4 text-xs [overflow-wrap:anywhere]">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-base font-semibold">Agent identity cards</h2>
      <button type="button" onClick={() => setRevision(value => value + 1)} className="min-h-11 px-3 text-amber-300 underline">Refresh identity cards</button>
    </div>
    <p className="text-gray-400">Live kernel checks, refreshed every 30 seconds. Config is not proof of outbound identity.
      Gateway-only connectors and channel bindings are unknown, not absent. Repair links use existing connector and grant controls.</p>
    {error && <p role="alert" className="text-red-300">Identity cards unavailable. Refresh to retry.</p>}
    {data && <p className="text-gray-400">Principal: {data.principalDid}</p>}
    {data?.cards.length === 0 && <p className="text-gray-400">No agents bound to this principal.</p>}
    {data?.cards.map(card => <AgentIdentityCard key={card.identity.did} card={card} />)}
  </section>;
}
