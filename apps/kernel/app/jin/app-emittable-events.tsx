'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface EventState {
  appId: string;
  approvedEmittableEvents: string[];
  declaredEmittableEvents: string[] | null;
  eventDeclarationError?: string;
}

const EVENTS_UPDATED = 'imajin:app-emittable-events-updated';

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isEventState(value: unknown): value is EventState {
  if (!value || typeof value !== 'object') return false;
  const state = value as EventState;
  return typeof state.appId === 'string' && state.appId.length > 0
    && isStringList(state.approvedEmittableEvents)
    && (state.declaredEmittableEvents === null || isStringList(state.declaredEmittableEvents))
    && (state.eventDeclarationError === undefined || typeof state.eventDeclarationError === 'string');
}

async function readEvents(appDid: string): Promise<EventState> {
  const response = await fetch(`/api/apps/service-scopes?appDid=${encodeURIComponent(appDid)}&includeEvents=true`, { credentials: 'include' });
  if (response.status === 401 || response.status === 403) throw new Error('Not authorized to read app event approvals. Sign in as the node operator.');
  if (!response.ok) throw new Error('App event approvals unavailable.');
  const body: unknown = await response.json();
  if (!isEventState(body)) throw new Error('Invalid app event approvals response.');
  return body;
}

async function saveEvents(appId: string, selected: string[]): Promise<string[]> {
  const response = await fetch(`/api/admin/registry/apps/${encodeURIComponent(appId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emittableEvents: selected }),
  });
  const body = await response.json().catch(() => ({})) as { error?: unknown; app?: { id?: unknown; emittableEvents?: unknown } } | null;
  if (response.status === 401 || response.status === 403) throw new Error('Not authorized to approve events. Sign in as the node operator.');
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Event approval failed (${response.status}).`);
  if (body?.app?.id !== appId || !isStringList(body.app.emittableEvents)) throw new Error('Invalid event approval response. Refresh to verify the saved list.');
  return body.app.emittableEvents;
}

/** Shared by provisioned and self-registered app rows. Scope proposals remain on their separate countersign rail. */
export function AppEmittableEvents({ appDid }: Readonly<{ appDid: string }>) {
  const [state, setState] = useState<EventState | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const cancelLoad = useCallback(() => { generation.current++; }, []);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setState(null);
    setOpen(false);
    setError('');
    setMessage('');
    try {
      const next = await readEvents(appDid);
      if (current !== generation.current) return;
      setState(next);
      setSelected(next.approvedEmittableEvents);
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : 'App event approvals unavailable.');
    }
  }, [appDid]);

  useEffect(() => {
    void load();
    const refresh = () => { void load(); };
    globalThis.addEventListener(EVENTS_UPDATED, refresh);
    globalThis.addEventListener('imajin:session-changed', refresh);
    return () => {
      cancelLoad();
      globalThis.removeEventListener(EVENTS_UPDATED, refresh);
      globalThis.removeEventListener('imajin:session-changed', refresh);
    };
  }, [load, cancelLoad]);

  function toggle(event: string) {
    setSelected((current) => current.includes(event) ? current.filter((item) => item !== event) : [...current, event]);
  }

  async function submit() {
    if (!state || busy) return;
    const current = generation.current;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await saveEvents(state.appId, selected);
      if (current !== generation.current) return;
      globalThis.dispatchEvent(new Event(EVENTS_UPDATED));
      setMessage('Event approvals saved. The selected set is effective immediately.');
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : 'Network error — event approvals could not be confirmed.');
    } finally {
      setBusy(false);
    }
  }

  const options = [...new Set([...(state?.declaredEmittableEvents ?? []), ...(state?.approvedEmittableEvents ?? [])])];

  return (
    <div className="min-w-0 w-full space-y-2 border-t border-gray-800 pt-2 pb-3 break-words" aria-label="App emittable events">
      <p className="text-gray-400">Declared emittable events: <span className="font-mono text-gray-200">{state?.declaredEmittableEvents?.join(', ') || (state?.declaredEmittableEvents ? 'None' : 'Unavailable')}</span></p>
      <p className="text-gray-400">Approved emittable events: <span className="font-mono text-green-300">{state ? state.approvedEmittableEvents.join(', ') || 'None' : 'Unavailable'}</span></p>
      {state?.declaredEmittableEvents === null && <p className="text-amber-300">{state.eventDeclarationError ?? 'Manifest declarations unavailable.'} Existing approvals can still be withdrawn.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!state || busy} aria-expanded={open} onClick={() => { setOpen(!open); setMessage(''); }}
          className="rounded bg-gray-800 px-2.5 py-1 text-gray-200 hover:bg-gray-700 disabled:opacity-40">Approve events</button>
        <button type="button" disabled={busy} onClick={() => void load()} className="px-2.5 py-1 text-gray-300 underline disabled:opacity-40">Refresh events</button>
      </div>
      {open && state && (
        <div className="space-y-2">
          <p className="text-gray-400">Admin approval is immediate, not a pending scope card. Saving replaces the entire approved event set and records an audit attestation. An empty selection withdraws all approvals.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || state.declaredEmittableEvents === null} onClick={() => setSelected(state.declaredEmittableEvents ?? [])}
              className="px-2.5 py-1 text-gray-200 underline disabled:opacity-40">Select declared set</button>
            <button type="button" disabled={busy} onClick={() => setSelected([])} className="px-2.5 py-1 text-gray-200 underline disabled:opacity-40">Clear selection</button>
          </div>
          <fieldset disabled={busy} className="max-h-60 space-y-1 overflow-y-auto">
            <legend className="text-gray-300">Emittable events to approve</legend>
            {options.map((event) => (
              <label key={event} className="flex items-start gap-2 text-gray-300">
                <input type="checkbox" checked={selected.includes(event)} onChange={() => toggle(event)} />
                <span className="min-w-0 break-all"><span className="font-mono">{event}</span>
                  {state.declaredEmittableEvents?.includes(event) ? ' (declared)' : ' (not in current declarations)'}
                  {state.approvedEmittableEvents.includes(event) && ' (approved)'}
                </span>
              </label>
            ))}
          </fieldset>
          <button type="button" disabled={busy} onClick={() => void submit()}
            className="rounded bg-amber-800/60 px-2.5 py-1 text-amber-100 disabled:opacity-40">{busy ? 'Saving…' : 'Save event approvals'}</button>
        </div>
      )}
      {error && <p role="alert" className="text-red-400">{error}</p>}
      {message && <output className="block text-green-300">{message}</output>}
    </div>
  );
}
