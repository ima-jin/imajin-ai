'use client';

import { useEffect, useRef, useState } from 'react';
import { getActingAsHeaders } from '@imajin/ui/server';
import { ALPHA_CHOICES, isAlphaIntent, type AlphaSubmissionsPage } from '@/src/lib/alpha/contract';
import { JinList, JinListPages } from './jin-list';

function isPage(body: unknown): body is AlphaSubmissionsPage {
  if (!body || typeof body !== 'object' || !('submissions' in body) || !('hasMore' in body)) return false;
  return typeof body.hasMore === 'boolean' && Array.isArray(body.submissions) && body.submissions.every(row =>
    row && ['id', 'name', 'email', 'company', 'purpose', 'createdAt'].every(field => typeof row[field] === 'string')
    && isAlphaIntent(row.intent) && Number.isFinite(Date.parse(row.createdAt)));
}

export function AlphaSubmissionsPanel() {
  const [intent, setIntent] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<AlphaSubmissionsPage | null>(null);
  const [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    const scopeChanged = () => {
      request.current?.abort();
      setPage(null); setError(false); setOffset(0); setRevision(value => value + 1);
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === null || event.key === 'imajin:acting-as') scopeChanged();
    };
    globalThis.addEventListener('imajin:session-changed', scopeChanged);
    globalThis.addEventListener('imajin:acting-as-changed', scopeChanged);
    globalThis.addEventListener('storage', storageChanged);
    return () => {
      globalThis.removeEventListener('imajin:session-changed', scopeChanged);
      globalThis.removeEventListener('imajin:acting-as-changed', scopeChanged);
      globalThis.removeEventListener('storage', storageChanged);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setPage(null); setError(false);
    const query = new URLSearchParams({ offset: String(offset) });
    if (intent) query.set('intent', intent);
    async function load() {
      try {
        const response = await fetch(`/jin/api/alpha-submissions?${query}`, {
          credentials: 'include', cache: 'no-store', headers: getActingAsHeaders(), signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403) { setPage(null); return; }
        if (!response.ok) throw new Error('Unavailable');
        const data: unknown = await response.json();
        if (!isPage(data)) throw new Error('Invalid response');
        if (!controller.signal.aborted) setPage(data);
      } catch {
        if (!controller.signal.aborted) { setPage(null); setError(true); }
      }
    }
    void load();
    return () => controller.abort();
  }, [intent, offset, revision]);

  if (!page && !error) return null;
  return <section id="alpha-submissions" aria-label="Alpha requests" className="mt-8 min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-base font-semibold">Alpha requests</h2>
        <p className="text-xs text-gray-400">Newest first · private operator intake</p></div>
      <label className="text-xs text-gray-400">Request type{' '}
        <select className="ml-2 min-h-11 rounded border border-gray-700 bg-gray-900 px-2 text-gray-100"
          value={intent} onChange={event => { setIntent(event.target.value); setOffset(0); }}>
          <option value="">All requests</option>
          {ALPHA_CHOICES.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select>
      </label>
      <button type="button" className="min-h-11 px-2 text-xs text-gray-400"
        onClick={() => setRevision(value => value + 1)}>Refresh alpha requests</button>
    </div>
    {error && <p role="alert" className="text-sm text-red-300">Alpha requests unavailable. Refresh to try again.</p>}
    {page && <>
      {page.submissions.length === 0 && <p className="text-sm text-gray-400">No matching alpha requests.</p>}
      <JinList>{page.submissions.map(row => <li key={row.id} className="min-w-0 rounded-lg border border-gray-800 p-3 [overflow-wrap:anywhere]">
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-sm">
            {row.company} · {ALPHA_CHOICES.find(choice => choice.value === row.intent)?.label}
            <time className="ml-3 text-xs text-gray-400" dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time>
          </summary>
          <dl className="space-y-2 text-sm text-gray-300">
            <div><dt className="text-gray-500">Name</dt><dd>{row.name}</dd></div>
            <div><dt className="text-gray-500">Work email</dt><dd>{row.email}</dd></div>
            <div><dt className="text-gray-500">What will your agents do for people?</dt><dd className="whitespace-pre-wrap">{row.purpose}</dd></div>
          </dl>
        </details>
      </li>)}</JinList>
      <JinListPages label="Alpha request pages" offset={offset} hasMore={page.hasMore} onOffset={setOffset}
        newer="Newer requests" older="Older requests" />
    </>}
  </section>;
}
