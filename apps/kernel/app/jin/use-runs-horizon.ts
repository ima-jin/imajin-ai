'use client';

import { useEffect, useState } from 'react';
import type { Horizon } from '@/src/lib/loops/horizon';

export interface RunHorizon {
  loopId: string;
  horizon: Horizon;
  commandAvailable: boolean;
}

/** Read the existing projection; never infer a zone from thread state or command delivery. */
export function useRunsHorizon(loopIds: string[], onDenied: () => void) {
  const [runs, setRuns] = useState<RunHorizon[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify(loopIds);
  useEffect(() => {
    const ids = JSON.parse(key) as string[];
    const controller = new AbortController();
    let inFlight = false;
    setRuns([]);
    setLoading(true);
    setError('');
    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const next: RunHorizon[] = [];
        // Bound concurrent reads even when the operator loads many history pages.
        for (let index = 0; index < ids.length; index += 6) {
          if (controller.signal.aborted) return;
          const batch = await Promise.allSettled(ids.slice(index, index + 6).map(async (loopId) => {
            const response = await fetch(`/jin/api/runs/${encodeURIComponent(loopId)}`, {
              credentials: 'include', signal: controller.signal, cache: 'no-store',
            });
            if (response.status === 401 || response.status === 403) {
              if (!controller.signal.aborted) onDenied();
              throw new Error('Authorization changed');
            }
            if (!response.ok) throw new Error('Horizon unavailable');
            const data = await response.json();
            if (!data.isOperator) {
              if (!controller.signal.aborted) onDenied();
              throw new Error('Authorization changed');
            }
            return { loopId, horizon: data.detail.horizon as Horizon,
              commandAvailable: data.commandTarget?.available === true };
          }));
          for (const result of batch) {
            if (result.status === 'rejected') throw result.reason;
            next.push(result.value);
          }
        }
        if (controller.signal.aborted) return;
        setRuns(next.filter(run => !!run.horizon));
        setError('');
      } catch {
        if (!controller.signal.aborted) {
          setError('Horizon refresh unavailable. Showing last observation; claims disabled.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
        inFlight = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [key, onDenied]);
  return { runs, error, loading };
}
