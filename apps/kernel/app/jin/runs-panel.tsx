'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LoopJson } from '@/src/lib/loops/serialize';
import type { LoopsPage } from '@/src/lib/loops/query';
import { isBlockedLoop, mergeRuns } from '@/src/lib/jin/runs-lane';
import { RunsPanelDetail } from './runs-panel-detail';

export function RunsPanel() {
  const [isOperator, setIsOperator] = useState(false);
  const [loops, setLoops] = useState<LoopJson[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const hide = useCallback(() => {
    setIsOperator(false);
    setLoops([]);
    setSelected(null);
    setNextCursor(null);
  }, []);

  const load = useCallback(async (cursor?: string) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
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
      setLoops((previous) => mergeRuns(cursor ? previous : [], page.loops));
      setNextCursor(page.nextCursor);
      setError(null);
    } catch {
      if (!controller.signal.aborted) setError('Runs unavailable. Try refreshing.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [hide]);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  if (!isOperator) return null;

  return (
    <section className="mt-8 min-w-0" data-testid="runs-lane">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-100">Runs</h2>
          <p className="text-xs text-gray-500">Signed loop registry · blockers first in loaded runs</p>
        </div>
        <button type="button" disabled={loading} onClick={() => { setSelected(null); void load(); }} className="min-h-11 text-xs text-gray-400 disabled:opacity-50">
          Refresh runs
        </button>
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
      {loops.length === 0 && <p className="text-sm text-gray-500">No loops recorded.</p>}
      <ul className="space-y-2">
        {loops.map((loop) => (
          <li key={loop.loopId} className="min-w-0 rounded-lg border border-gray-800" data-testid="run-card">
            <button
              type="button"
              aria-expanded={selected === loop.loopId}
              onClick={() => setSelected((value) => value === loop.loopId ? null : loop.loopId)}
              className="min-h-11 w-full px-3 py-3 text-left"
            >
              <span className="block break-words text-sm text-gray-100">{loop.summary}</span>
              <span className="mt-1 flex flex-wrap gap-2 text-xs text-gray-400">
                <span>{loop.kind}</span>
                <span className={isBlockedLoop(loop) ? 'text-amber-300' : 'text-gray-300'}>{loop.state}</span>
                {isBlockedLoop(loop) && <span className="text-amber-300">Needs attention</span>}
              </span>
              <time className="mt-1 block break-all text-[11px] text-gray-500" dateTime={loop.lastSeenAt}>{loop.lastSeenAt}</time>
            </button>
            {selected === loop.loopId && (
              <div className="px-3 pb-3"><RunsPanelDetail loopId={selected} onSelect={setSelected} onDenied={hide} /></div>
            )}
          </li>
        ))}
      </ul>
      {selected && !loops.some((loop) => loop.loopId === selected) && (
        <div className="mt-3 rounded-lg border border-gray-800 p-3">
          <button type="button" className="min-h-11 text-xs text-gray-400" onClick={() => setSelected(null)}>Close run history</button>
          <RunsPanelDetail loopId={selected} onSelect={setSelected} onDenied={hide} />
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
