'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { connectionSlot } from '@/src/lib/kernel/connection-slots';

const SlotContext = createContext('primary');
export const useConnectionSlot = () => useContext(SlotContext);
const RefreshContext = createContext<() => void>(() => {});
export const useRefreshConnections = () => useContext(RefreshContext);

/** Omitted selectors remain the legacy primary connection. */
export function slotRoute(route: string, slot: string): string {
  if (slot === 'primary') return route;
  const url = new URL(route, 'http://localhost');
  url.searchParams.set('slot', slot);
  return `${url.pathname}${url.search}${url.hash}`;
}

interface Connection {
  slot: string;
  label: string;
  accountEmail: string | null;
  connected: boolean;
  configured?: boolean;
  scopes?: string[];
}

const PRIMARY: Connection = { slot: 'primary', label: 'Primary', accountEmail: null, connected: false };
const inputClass = 'w-full min-w-0 rounded-lg border border-white/20 bg-black/30 px-3 py-2 text-sm text-white';
const buttonClass = 'rounded-lg border border-white/20 px-3 py-2 text-sm text-gray-200 hover:bg-white/10 disabled:opacity-50';

export function ConnectionSlots({ connectorId, children }: Readonly<{
  connectorId: string;
  children: (slot: string) => ReactNode;
}>) {
  const params = useSearchParams();
  const requested = params.get('slot');
  let initial = 'primary';
  let invalidSlot = false;
  try { initial = connectionSlot(requested); } catch { invalidSlot = true; }
  const [slot, setSlot] = useState(initial);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newSlot, setNewSlot] = useState('');
  const [label, setLabel] = useState('');
  const [rename, setRename] = useState('');
  const [busy, setBusy] = useState(false);
  const endpoint = `/connections/api/connectors/${encodeURIComponent(connectorId)}/connections`;
  const refresh = useCallback(() => {
    // Background metadata refresh keeps account identity/current connection
    // badges up to date without unmounting the in-progress configure form.
    void fetch(endpoint).then(async (response) => {
      if (!response.ok) return;
      const data = await response.json();
      if (Array.isArray(data.connections)) {
        const listed: Connection[] = data.connections;
        setConnections(listed.some((c) => c.slot === 'primary') ? listed : [PRIMARY, ...listed]);
      }
    }).catch(() => { /* The per-slot status control reports action errors. */ });
  }, [endpoint]);

  useEffect(() => {
    if (!invalidSlot) setSlot(initial);
  }, [initial, invalidSlot]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(endpoint);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? 'Could not load connections.');
        if (!cancelled) {
          const listed: Connection[] = Array.isArray(data.connections) ? data.connections : [];
          setConnections(listed.some((c) => c.slot === 'primary') ? listed : [PRIMARY, ...listed]);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load connections.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [endpoint]);

  const selected = connections.find((connection) => connection.slot === slot);
  useEffect(() => { setRename(selected?.label ?? ''); }, [selected?.label, slot]);

  function select(next: string) {
    setSlot(next);
    setError(null);
    const url = new URL(window.location.href);
    url.searchParams.set('slot', next);
    // A previous callback outcome must not appear on a different connection.
    for (const key of ['connected', 'connector', 'error']) url.searchParams.delete(key);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  async function save(event: React.FormEvent, create: boolean) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const target = create ? connectionSlot(newSlot) : slot;
      if (create && !newSlot.trim()) throw new Error('Enter a connection slot.');
      if (create && connections.some((c) => c.slot === target)) throw new Error('That slot already exists. Choose it above.');
      const nextLabel = (create ? label : rename).trim();
      if (!nextLabel) throw new Error('Enter a connection label.');
      const response = await fetch(create ? endpoint : `${endpoint}?slot=${encodeURIComponent(target)}`, {
        method: create ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(create ? { slot: target, label: nextLabel } : { label: nextLabel }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not save connection.');
      setConnections((current) => create
        ? [...current, { slot: target, label: nextLabel, accountEmail: null, connected: false }]
        : current.map((c) => c.slot === target ? { ...c, label: nextLabel } : c));
      if (create) {
        select(target);
        setAdding(false);
        setNewSlot('');
        setLabel('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save connection.');
    } finally { setBusy(false); }
  }

  return (
    <div className="min-w-0 space-y-4">
      <section aria-label="Connections" className="min-w-0 rounded-xl border border-white/10 bg-white/5 p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">Connections</h2>
          <button type="button" className={buttonClass} onClick={() => setAdding(!adding)} disabled={loading || busy}>
            {adding ? 'Cancel add' : 'Add connection'}
          </button>
        </div>
        {loading && <p className="text-sm text-gray-400">Loading connections…</p>}
        {!loading && connections.length > 0 && (
          <>
            <ul aria-label="Connection accounts" className="min-w-0 space-y-2">
              {connections.map((connection) => (
                <li key={connection.slot} className="min-w-0">
                  <button type="button" aria-pressed={connection.slot === slot}
                    onClick={() => select(connection.slot)} disabled={busy}
                    className={`w-full min-w-0 rounded-lg border p-3 text-left transition disabled:opacity-50 ${
                      connection.slot === slot
                        ? 'border-amber-500/50 bg-amber-500/10'
                        : 'border-white/10 hover:border-white/30 hover:bg-white/5'
                    }`}>
                    <span className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="min-w-0 break-all text-sm font-medium text-white">{connection.label}</span>
                      <span className={`text-xs ${connection.connected ? 'text-green-400' : 'text-gray-400'}`}>
                        {connection.connected ? 'Connected' : 'Not connected'}
                      </span>
                    </span>
                    <span className="mt-1 block break-all text-sm text-gray-300">
                      {connection.accountEmail ?? 'No account connected'}
                    </span>
                    <span className="mt-1 block break-all font-mono text-xs text-gray-500">{connection.slot}</span>
                  </button>
                </li>
              ))}
            </ul>
            <label className="block text-sm text-gray-300">
              <span className="block">Selected connection</span>
              <select aria-label="Selected connection" className={`${inputClass} mt-2`} value={slot}
                disabled={busy} onChange={(event) => select(event.target.value)}>
                {!selected && <option value={slot}>{slot} — not found</option>}
                {connections.map((c) => (
                  <option key={c.slot} value={c.slot}>
                    {c.label} ({c.slot}){c.accountEmail ? ` — ${c.accountEmail}` : ''}{c.connected ? ' — Connected' : ' — Not connected'}
                  </option>
                ))}
              </select>
            </label>
            {selected && (
              <div className="space-y-2">
                <p className="break-all text-sm text-gray-400">{selected.accountEmail ?? 'No account connected'} · {selected.slot}</p>
                <form onSubmit={(event) => { void save(event, false); }} className="flex flex-wrap gap-2">
                  <label className="min-w-0 flex-1 basis-40 text-xs text-gray-400">
                    <span className="block">Connection label</span>
                    <input aria-label="Connection label" className={`${inputClass} mt-1`} maxLength={80}
                      value={rename} onChange={(event) => setRename(event.target.value)} disabled={busy} />
                  </label>
                  <button type="submit" className={`${buttonClass} self-end`}
                    disabled={busy || !rename.trim() || rename.trim() === selected.label}>Save label</button>
                </form>
              </div>
            )}
          </>
        )}
        {adding && (
          <form aria-label="Add connection" onSubmit={(event) => { void save(event, true); }} className="space-y-3 border-t border-white/10 pt-4">
            <label className="block text-sm text-gray-300">
              <span className="block">Slot</span>
              <input aria-label="New connection slot" className={`${inputClass} mt-1`} placeholder="work"
                value={newSlot} onChange={(event) => setNewSlot(event.target.value)} required maxLength={64} />
            </label>
            <p className="text-xs text-gray-400">Use a unique lowercase slot, such as work or personal. Slots cannot be renamed.</p>
            <label className="block text-sm text-gray-300">
              <span className="block">Label</span>
              <input aria-label="New connection label" className={`${inputClass} mt-1`} placeholder="Work account"
                value={label} onChange={(event) => setLabel(event.target.value)} required maxLength={80} />
            </label>
            <button type="submit" className={buttonClass} disabled={busy || !newSlot.trim() || !label.trim()}>
              {busy ? 'Saving…' : 'Create connection'}
            </button>
          </form>
        )}
        {error && <p role="alert" className="break-words text-sm text-red-400">{error}</p>}
        {invalidSlot && <p role="alert" className="text-sm text-red-400">Invalid connection slot. Choose a valid connection.</p>}
        {!loading && !selected && !error && <p role="alert" className="text-sm text-red-400">Connection not found. Choose a connection or add one.</p>}
      </section>
      {!loading && selected && !invalidSlot && (
        <SlotContext.Provider value={slot}>
          <RefreshContext.Provider value={refresh}>
            <div key={slot}>{children(slot)}</div>
          </RefreshContext.Provider>
        </SlotContext.Provider>
      )}
    </div>
  );
}
