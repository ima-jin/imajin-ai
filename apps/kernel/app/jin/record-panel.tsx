'use client';

import { useEffect, useState } from 'react';
import type { RecordEventRow, RecordEventsPage } from '@/src/lib/jin/record-events';

const defaultTransport: typeof fetch = (...args) => fetch(...args);
const PAGE_SIZE = 50;
type ActorFilter = '' | RecordEventRow['kind'];

function RecordRow({ event }: Readonly<{ event: RecordEventRow }>) {
  return (
    <li className="min-w-0 rounded-lg border border-gray-800 p-3 space-y-2" data-testid="record-row">
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <span className="rounded bg-indigo-900/40 px-2 py-1 text-xs text-indigo-300">
          {event.kind === 'agent' ? 'Agent' : 'Person'}
        </span>
        <span className="min-w-0 break-all font-mono text-xs text-gray-200">{event.who}</span>
      </div>
      <p className="break-all text-sm text-gray-200">{event.action}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
        <span className="break-all">{event.service}</span>
        <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
        {event.status && <span className="break-all">{event.status}</span>}
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {event.grantRef && (
          <a href={event.grantRef.href} className="min-h-11 max-w-full break-all p-2 text-indigo-400 underline">
            Grant · {event.grantRef.grantId}
          </a>
        )}
        {event.approvalRef && (
          <a href={event.approvalRef.href} className="min-h-11 max-w-full break-all p-2 text-indigo-400 underline">
            Approval · {event.approvalRef.proposalId}
          </a>
        )}
      </div>
      {event.approvalRef?.chosenOption && <p className="text-xs text-gray-400">Chosen option: {event.approvalRef.chosenOption}</p>}
      {event.hasOperatorSignature && <p className="text-xs text-gray-400">Operator signature present</p>}
      {event.modeCountersignLabel && <p className="text-xs text-amber-400">{event.modeCountersignLabel}</p>}
    </li>
  );
}

/** The session cookie selects the read principal; no client DID or acting-for override. */
export function RecordPanel({ transport = defaultTransport }: Readonly<{ transport?: typeof fetch }> = {}) {
  const [kind, setKind] = useState<ActorFilter>('');
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<RecordEventsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setPage(null);
    setLoading(true);
    setError(false);
    setDenied(false);
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (kind) query.set('kind', kind);
    async function load() {
      try {
        const response = await transport(`/jin/api/events?${query}`, {
          credentials: 'include', cache: 'no-store', signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          setDenied(true);
          return;
        }
        if (!response.ok) throw new Error('Record unavailable');
        const data = await response.json() as RecordEventsPage;
        if (!controller.signal.aborted) setPage(data);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [kind, offset, refresh, transport]);

  if (denied) return null;

  return (
    <section id="record" aria-label="Record" className="mt-8 min-w-0" data-testid="record-panel">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-100">Record</h2>
          <p className="text-xs text-gray-500">Signed events for your current identity</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-gray-400">
            Show
            <select
              aria-label="Record actor"
              value={kind}
              onChange={event => { setKind(event.target.value as ActorFilter); setOffset(0); }}
              className="ml-2 min-h-11 rounded border border-gray-700 bg-gray-900 px-2 text-gray-100"
            >
              <option value="">People and agents</option>
              <option value="person">Person only</option>
              <option value="agent">Agent only</option>
            </select>
          </label>
          <button type="button" onClick={() => setRefresh(value => value + 1)} className="min-h-11 px-2 text-xs text-gray-400">
            Refresh record
          </button>
        </div>
      </div>
      {loading && <p role="status" className="text-sm text-gray-500">Loading record…</p>}
      {error && <p role="alert" className="text-sm text-red-300">Could not load record. Refresh to try again.</p>}
      {page && (
        <>
          {page.events.length === 0 && <p className="text-sm text-gray-500">No matching events.</p>}
          <ul className="space-y-3 min-w-0">{page.events.map(event => <RecordRow key={event.id} event={event} />)}</ul>
          <nav aria-label="Record pages" className="mt-3 flex flex-wrap items-center gap-3 text-xs text-gray-400">
            <button type="button" disabled={page.offset === 0} onClick={() => setOffset(Math.max(0, page.offset - page.limit))} className="min-h-11 px-2 disabled:opacity-40">
              Newer events
            </button>
            <span>{page.total} matching events</span>
            <button type="button" disabled={page.offset + page.limit >= page.total} onClick={() => setOffset(page.offset + page.limit)} className="min-h-11 px-2 disabled:opacity-40">
              Older events
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
