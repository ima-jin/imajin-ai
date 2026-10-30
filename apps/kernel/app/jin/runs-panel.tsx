'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LoopJson, LoopEventJson } from '@/src/lib/loops/serialize';
import type { LoopsPage } from '@/src/lib/loops/query';
import { conflictsForLoop, isBlockedLoop, mergeRuns, runTree, visibleRuns } from '@/src/lib/jin/runs-lane';
import { RunsPanelDetail } from './runs-panel-detail';
import { ApprovalControllerNotices, useRunApprovals } from './operator-approvals-panel';
import type { SessionCommandClient } from './session-command-client';
import { RunApprovalRows } from './runs-approval-rows';
import { RunsHorizon } from './runs-horizon';

async function loadSurfaceWarnings(
  signal: AbortSignal, onDenied: () => void, onData: (events: LoopEventJson[]) => void,
) {
  const surfaces = await fetch('/api/loops/surfaces', { credentials: 'include', signal });
  if (signal.aborted) return;
  if (surfaces.status === 401 || surfaces.status === 403) { onDenied(); return; }
  if (!surfaces.ok) return;
  const observations = await surfaces.json() as { conflicts: LoopEventJson[] };
  if (!signal.aborted) onData(observations.conflicts ?? []);
}

export function RunsPanel({ client }: Readonly<{ client?: SessionCommandClient }> = {}) {
  const [isOperator, setIsOperator] = useState(false);
  const [loops, setLoops] = useState<LoopJson[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const [conflicts, setConflicts] = useState<LoopEventJson[]>([]);
  const approvals = useRunApprovals(client?.prepare);

  const hide = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setLoading(false);
    setIsOperator(false);
    setLoops([]);
    setSelected(null);
    setNextCursor(null);
    setConflicts([]);
  }, []);

  const load = useCallback(async (cursor?: string, silent = false) => {
    if (silent && controllerRef.current) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    if (!silent) setLoading(true);
    try {
      const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const response = await fetch(`/jin/api/runs${suffix}`, { credentials: 'include', signal: controller.signal });
      if (controller.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        hide();
        return;
      }
      if (!response.ok) throw new Error('Runs unavailable');
      const data = await response.json() as { isOperator: boolean; page: LoopsPage | null };
      if (controller.signal.aborted) return;
      if (!data.isOperator || !data.page) {
        hide();
        return;
      }
      const page = data.page;
      setIsOperator(true);
      setLoops((previous) => mergeRuns(cursor || silent ? previous : [], page.loops));
      if (!silent) setNextCursor(page.nextCursor);
      setError(null);
      await loadSurfaceWarnings(controller.signal, hide, setConflicts);
    } catch {
      if (!controller.signal.aborted) setError('Runs unavailable. Try refreshing.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [hide]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(undefined, true), 5000);
    return () => { controllerRef.current?.abort(); clearInterval(timer); };
  }, [load]);

  if (!isOperator) return null;
  const threads = visibleRuns(loops);

  return (
    <section className="mt-8 min-w-0" data-testid="runs-lane">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-100">Runs</h2>
          <p className="text-xs text-gray-500">Signed loop registry · loop-addressed commands</p>
          <a href="/jin/brief-settings" className="inline-flex min-h-11 items-center text-xs text-indigo-300">Brief storage settings</a>
        </div>
        <button type="button" disabled={loading} onClick={() => void load()} className="min-h-11 text-xs text-gray-400 disabled:opacity-50">
          Refresh runs
        </button>
      </div>
      {approvals.approvals.some((card) => card.sessionBinding && card.status !== 'pending') && <div className="mb-4 min-w-0">
        <h3 className="text-sm font-semibold">Recent approval decisions</h3>
        <RunApprovalRows cards={approvals.approvals.filter((card) => !!card.sessionBinding && card.status !== 'pending')} controller={approvals} />
      </div>}
      {error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
      <RunsHorizon loopIds={loops.map(loop => loop.loopId).sort((a, b) => a.localeCompare(b))} onDenied={hide} onSelect={setSelected} client={client} hasMore={!!nextCursor} />
      <div className="mb-4 min-w-0 space-y-2" data-testid="blocked-on-you">
        <h3 className="text-sm font-semibold text-amber-200">Blocked on you</h3>
        <ApprovalControllerNotices controller={approvals} />
        {loops.filter(isBlockedLoop).map((loop) => <button key={loop.loopId} type="button" className="block min-h-11 w-full min-w-0 break-words rounded border border-amber-900 p-3 text-left text-sm" onClick={() => setSelected(loop.loopId)}>{loop.summary} · Needs attention</button>)}
        {approvals.error && <p role="alert">{approvals.error}</p>}
        <RunApprovalRows cards={approvals.approvals.filter((card) => card.status === 'pending')} controller={approvals} />
        {!loops.some(isBlockedLoop) && !approvals.approvals.some((card) => card.status === 'pending') && <p className="text-xs text-gray-500">Nothing blocked in loaded runs or pending approvals.</p>}
      </div>
      <h3 className="mb-2 text-sm font-semibold">Threads</h3>
      {threads.length === 0 && <p className="text-sm text-gray-500">No loops recorded.</p>}
      <ul className="space-y-2">
        {runTree(threads).map(({ loop, depth, orphan }) => (
          <li key={loop.loopId} id={`run-${encodeURIComponent(loop.loopId)}`} className="min-w-0 rounded-lg border border-gray-800" style={{ marginLeft: `${Math.min(depth, 3) * 8}px` }} data-testid="run-card">
            <button
              type="button"
              aria-expanded={selected === loop.loopId}
              onClick={() => setSelected((value) => value === loop.loopId ? null : loop.loopId)}
              className="min-h-11 w-full px-3 py-3 text-left"
            >
              <span className="block break-words text-sm text-gray-100">{loop.summary}</span>
              {orphan && <span className="block text-xs text-gray-500">Parent outside loaded page</span>}
              <span className="mt-1 flex flex-wrap gap-2 text-xs text-gray-400">
                <span>{loop.kind}</span>
                <span className={isBlockedLoop(loop) ? 'text-amber-300' : 'text-gray-300'}>{loop.state}</span>
                {isBlockedLoop(loop) && <span className="text-amber-300">Needs attention</span>}
              </span>
              <time className="mt-1 block break-all text-[11px] text-gray-500" dateTime={loop.lastSeenAt}>{loop.lastSeenAt}</time>
            </button>
            {conflictsForLoop(loop.loopId, conflicts).map((conflict) => <details key={conflict.id} className="min-w-0 break-words px-3 text-xs text-amber-300">
              <summary className="min-h-11 cursor-pointer py-3">Surface conflict · warning only</summary>
              <p className="break-all pb-3">{conflict.surface} · {conflict.loopId} ↔ {conflict.otherLoopId}. Observation only; neither thread is stopped.</p>
            </details>)}
            {selected === loop.loopId && (
              <div className="px-3 pb-3">
                <RunsPanelDetail loopId={selected} onSelect={setSelected} onDenied={hide} client={client} />
                <RunApprovalRows cards={approvals.approvals.filter((card) => card.sessionBinding?.loopId === selected)} controller={approvals} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {loops.some(loop => loop.state.toLowerCase() === 'archived') && <details className="mt-3">
        <summary className="min-h-11 cursor-pointer py-3 text-xs text-gray-400">Archived run history</summary>
        {loops.filter(loop => loop.state.toLowerCase() === 'archived').map(loop => <button
          key={loop.loopId} type="button" className="block min-h-11 break-words text-left text-xs text-indigo-300"
          onClick={() => setSelected(loop.loopId)}
        >{loop.summary} · archived history</button>)}
      </details>}
      {selected && !threads.some((loop) => loop.loopId === selected) && (
        <div className="mt-3 rounded-lg border border-gray-800 p-3">
          <button type="button" className="min-h-11 text-xs text-gray-400" onClick={() => setSelected(null)}>Close run history</button>
          <RunsPanelDetail loopId={selected} onSelect={setSelected} onDenied={hide} client={client} />
          <RunApprovalRows cards={approvals.approvals.filter((card) => card.sessionBinding?.loopId === selected)} controller={approvals} />
        </div>
      )}
      {nextCursor && (
        <button type="button" disabled={loading} onClick={() => void load(nextCursor)} className="mt-2 min-h-11 text-sm text-indigo-300 disabled:opacity-50">
          {loading ? 'Loading runs…' : 'Load more runs'}
        </button>
      )}
    </section>
  );
}
