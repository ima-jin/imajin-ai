'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { getActingAsHeaders } from '@imajin/ui/server';
import type { NavApp } from '@/src/lib/kernel/app-nav';

type DirectoryApp = NavApp & {
  description: string | null;
  featured: boolean;
  added: boolean;
  authorized: boolean;
  available: boolean;
};

async function readDirectory(url: string, signal: AbortSignal, method = 'GET'): Promise<DirectoryApp[]> {
  const response = await fetch(url, {
    method, signal, credentials: 'include', cache: 'no-store', headers: getActingAsHeaders(),
  });
  const data = await response.json() as { apps?: DirectoryApp[]; error?: string };
  if (!response.ok) throw new Error(data.error ?? 'Unable to update the app directory.');
  if (!Array.isArray(data.apps)) throw new Error('Unable to read the app directory.');
  return data.apps;
}

function DirectoryRow({ app, busy, disabled, onToggle }: Readonly<{
  app: DirectoryApp;
  busy: boolean;
  disabled: boolean;
  onToggle: (app: DirectoryApp) => void;
}>) {
  let action = app.added ? 'Remove' : 'Add';
  if (busy) action = app.added ? 'Removing…' : 'Adding…';
  return (
    <li className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5" aria-busy={busy}>
      <div className="flex items-start gap-4">
        <span className="text-3xl" aria-hidden="true">{app.icon ?? '🧩'}</span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold text-zinc-100">{app.name}</h2>
            {app.featured && <span className="rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400">Featured</span>}
            {app.added && <span className="text-xs text-green-400">Added</span>}
          </div>
          <p className="text-sm text-zinc-400">{app.description || 'No description provided.'}</p>
          {!app.available && (
            <p className="text-sm text-zinc-400">
              Unavailable for this identity{app.requiredScope ? ` — requires ${app.requiredScope} scope` : ''}.
            </p>
          )}
          {app.authorized && (
            <p className="text-sm text-amber-400">
              Authorized — <Link href="/jin#grants" className="underline">manage in Grants</Link>
            </p>
          )}
          {app.inherited && (
            <p className="text-sm text-zinc-400">Included through identity membership. Leaving the owning identity removes this app.</p>
          )}
          <button
            type="button"
            onClick={() => onToggle(app)}
            disabled={disabled || app.inherited || (!app.available && !app.added)}
            aria-label={`${action} ${app.name}`}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 hover:border-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {app.inherited ? 'Included with membership' : action}
          </button>
        </div>
      </div>
    </li>
  );
}

export default function AppDirectoryPage() {
  const router = useRouter();
  const [apps, setApps] = useState<DirectoryApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const refresh = () => {
      pending.current?.abort();
      setApps([]);
      setBusySlug(null);
      setNotice('');
      setRevision((value) => value + 1);
    };
    globalThis.addEventListener('imajin:acting-as-changed', refresh);
    globalThis.addEventListener('imajin:session-changed', refresh);
    return () => {
      pending.current?.abort();
      globalThis.removeEventListener('imajin:acting-as-changed', refresh);
      globalThis.removeEventListener('imajin:session-changed', refresh);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError('');
    const slug = new URLSearchParams(globalThis.location.search).get('app');
    const url = slug ? `/auth/api/apps/${encodeURIComponent(slug)}` : '/auth/api/apps/directory';
    void readDirectory(url, controller.signal)
      .then((rows) => { if (!controller.signal.aborted) setApps(rows); })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load apps.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  async function toggleApp(app: DirectoryApp) {
    if (busySlug) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusySlug(app.slug);
    setError('');
    setNotice('');
    try {
      const rows = await readDirectory(`/auth/api/apps/${encodeURIComponent(app.slug)}`, controller.signal, app.added ? 'DELETE' : 'PUT');
      if (controller.signal.aborted) return;
      setApps(rows);
      setNotice(app.added ? `${app.name} removed from added apps. Existing authorizations are unchanged.` : `${app.name} added.`);
      router.refresh();
      globalThis.dispatchEvent(new Event('imajin:apps-changed'));
    } catch (cause: unknown) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to update apps.');
    } finally {
      if (!controller.signal.aborted) setBusySlug(null);
    }
  }

  return (
    <section className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-zinc-100">App directory</h1>
        <p className="text-sm text-zinc-400">Choose apps for this identity. Removing an app never revokes its authorization.</p>
      </header>
      {loading && <output className="block text-zinc-400">Loading apps…</output>}
      {error && (
        <div role="alert" className="space-y-2 text-red-400">
          <p>{error}</p>
          <button type="button" disabled={busySlug !== null} onClick={() => setRevision((value) => value + 1)} className="underline">
            Retry
          </button>
        </div>
      )}
      <output aria-live="polite" className="block text-sm text-zinc-400">{notice}</output>
      {!loading && !error && apps.length === 0 && <p className="text-zinc-400">No apps are registered yet.</p>}
      <ul className="space-y-4" aria-label="Registered apps">
        {apps.map((app) => (
          <DirectoryRow key={app.slug} app={app} busy={busySlug === app.slug} disabled={busySlug !== null} onToggle={toggleApp} />
        ))}
      </ul>
    </section>
  );
}
