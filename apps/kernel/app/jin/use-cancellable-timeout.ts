import { useCallback, useEffect, useRef } from 'react';

/**
 * Returns a stable `schedule(fn, ms)` that runs `fn` after `ms` milliseconds —
 * but, unlike a bare `setTimeout`, (a) a new call replaces any still-pending
 * one (so the latest flash/“Copied!” window always wins) and (b) the pending
 * timer is cancelled on unmount, so no callback can fire after the component
 * is gone (or after the test environment's jsdom is torn down, #2492).
 */
export function useCancellableTimeout(): (fn: () => void, ms: number) => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return useCallback((fn: () => void, ms: number) => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      fn();
    }, ms);
  }, []);
}
