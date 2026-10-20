'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { APPROVALS_REFRESH_EVENT, approvalCardAnchorId } from './approval-anchor';
import { isScopeState, ProvisionedAppScopes, type ScopeState } from './provisioned-app-scopes';
import { AppEmittableEvents } from './app-emittable-events';

interface RegisteredApp extends ScopeState {
  appDid: string;
  name: string;
  status: string;
  approvalId: string | null;
  approvedAt: string | null;
}
async function readAppPage(cursor?: string): Promise<AppPage | null> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const response = await fetch(`/api/apps/service-scopes${query}`, { credentials: 'include' });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error('Registered apps unavailable');
  const body: unknown = await response.json();
  if (!isAppPage(body)) throw new Error('Invalid registered apps response');
  return body;
}

async function readLoadedPages(pageCount: number): Promise<AppPage | null> {
  let page = await readAppPage();
  if (!page) return null;
  for (let index = 1; index < pageCount && page.nextCursor; index++) {
    const next = await readAppPage(page.nextCursor);
    if (!next) return null;
    page = { apps: appendApps(page.apps, next.apps), nextCursor: next.nextCursor };
  }
  return page;
}
function appendApps(previous: RegisteredApp[], next: RegisteredApp[]): RegisteredApp[] {
  const nextDids = new Set(next.map((app) => app.appDid));
  return [...previous.filter((app) => !nextDids.has(app.appDid)), ...next];
}

interface AppPage {
  apps: RegisteredApp[];
  nextCursor: string | null;
}

function isRegisteredApp(value: unknown): value is RegisteredApp {
  if (!isScopeState(value)) return false;
  const app = value as RegisteredApp;
  return typeof app.appDid === 'string' && typeof app.name === 'string' && typeof app.status === 'string'
    && (app.approvalId === null || typeof app.approvalId === 'string')
    && (app.approvedAt === null || typeof app.approvedAt === 'string');
}

function isAppPage(value: unknown): value is AppPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as AppPage;
  return Array.isArray(page.apps) && page.apps.every(isRegisteredApp)
    && (page.nextCursor === null || typeof page.nextCursor === 'string');
}

/** Registry discovery; scope writes remain countersigned cards, event writes use the existing admin PATCH. */
export function RegisteredAppScopesPanel() {
  const [visible, setVisible] = useState(false);
  const [apps, setApps] = useState<RegisteredApp[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const loadedPageCount = useRef(1);
  const cancelLoad = useCallback(() => { generation.current++; }, []);

  const load = useCallback(async (cursor?: string) => {
    const current = ++generation.current;
    setBusy(true);
    setError(false);
    try {
      const body = cursor ? await readAppPage(cursor) : await readLoadedPages(loadedPageCount.current);
      if (current !== generation.current) return;
      if (!body) {
        setVisible(false);
        setApps([]);
        setNextCursor(null);
        return;
      }
      if (cursor) loadedPageCount.current++;
      setVisible(true);
      setApps((previous) => cursor ? appendApps(previous, body.apps) : body.apps);
      setNextCursor(body.nextCursor);
    } catch {
      if (current === generation.current) {
        setVisible(true);
        setError(true);
        if (!cursor) {
          setApps([]);
          setNextCursor(null);
        }
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => { void load(); };
    globalThis.addEventListener(APPROVALS_REFRESH_EVENT, refresh);
    globalThis.addEventListener('imajin:session-changed', refresh);
    return () => {
      cancelLoad();
      globalThis.removeEventListener(APPROVALS_REFRESH_EVENT, refresh);
      globalThis.removeEventListener('imajin:session-changed', refresh);
    };
  }, [load, cancelLoad]);

  if (!visible) return null;

  return (
    <section className="mt-8 space-y-3 text-xs" aria-label="Registered app service scopes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-gray-100">Registered app service scopes</h2>
          <p className="text-gray-400">All registry apps, including self-registered apps. Requests are not grants.</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void load()} className="px-3 py-2 text-gray-300 disabled:opacity-40">Refresh registered apps</button>
      </div>
      {error && <p role="alert" className="text-red-400">Registered apps unavailable. Refresh to retry; no approval state can be inferred from this failed read.</p>}
      {busy && <output className="block text-gray-400">Loading registered apps…</output>}
      {!busy && !error && apps.length === 0 && <p className="text-gray-400">No registered apps.</p>}
      <ul className="space-y-3">
        {apps.map((app) => (
          <li key={app.appDid} className="min-w-0 space-y-2 border border-gray-800 p-3 break-words">
            <h3 className="font-semibold text-gray-200">{app.name}</h3>
            <p className="font-mono break-all text-gray-400">{app.appDid}</p>
            <p className="text-gray-400">Registry status: {app.status}</p>
            <ProvisionedAppScopes appDid={app.appDid} initialScopes={app} />
            <AppEmittableEvents appDid={app.appDid} />
            {app.approvalId && <p className="text-gray-400">Recorded approval: <a className="underline" href={`#${approvalCardAnchorId(app.approvalId)}`}>{app.approvalId}</a>{app.approvedAt && ` · ${app.approvedAt}`}. Review signed decisions and audit in Operator approvals.</p>}
          </li>
        ))}
      </ul>
      {nextCursor && <button type="button" disabled={busy} onClick={() => void load(nextCursor)} className="border border-gray-700 px-3 py-2 text-gray-200 disabled:opacity-40">Load more registered apps</button>}
    </section>
  );
}
