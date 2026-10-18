'use client';

import { useEffect, useState } from 'react';
import type { Horizon } from '@/src/lib/loops/horizon';

export interface RunHorizon {
  loopId: string;
  horizon: Horizon;
  commandAvailable: boolean;
}
function requireHorizon(value: Horizon | undefined): Horizon {
  if (!value || !Array.isArray(value.steps) || !Number.isInteger(value.depth)
    || value.depth < 0 || value.targetDepth !== 12) {
    throw new Error('Incomplete horizon observation');
  }
  return value;
}

async function readHorizon(loopId: string, signal: AbortSignal, onDenied: () => void): Promise<RunHorizon> {
  const response = await fetch(`/jin/api/runs/${encodeURIComponent(loopId)}`, {
    credentials: 'include', signal, cache: 'no-store',
  });
  if (response.status === 401 || response.status === 403) {
    if (!signal.aborted) onDenied();
    throw new Error('Authorization changed');
  }
  if (!response.ok) throw new Error('Horizon unavailable');
  const data = await response.json();
  if (!data.isOperator) {
    if (!signal.aborted) onDenied();
    throw new Error('Authorization changed');
  }
  return { loopId, horizon: requireHorizon(data.detail?.horizon),
    commandAvailable: data.commandTarget?.available === true };
}

/** Await every sibling, then advance the bounded batch; failure never releases a partial observation. */
async function readBatches(ids: string[], signal: AbortSignal, onDenied: () => void): Promise<RunHorizon[]> {
  if (signal.aborted || ids.length === 0) return [];
  const settled = await Promise.allSettled(ids.slice(0, 6).map(loopId => readHorizon(loopId, signal, onDenied)));
  const batch = settled.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  return [...batch, ...await readBatches(ids.slice(6), signal, onDenied)];
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
        const next = await readBatches(ids, controller.signal, onDenied);
        if (controller.signal.aborted) return;
        setRuns(next);
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
