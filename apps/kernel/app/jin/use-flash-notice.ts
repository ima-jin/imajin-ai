import { useCallback, useState } from 'react';
import { useCancellableTimeout } from './use-cancellable-timeout';

export interface FlashNotice {
  type: 'ok' | 'err';
  msg: string;
}

/**
 * Transient ok/err banner state shared by the /jin panels: `notify` shows a
 * message and auto-clears it after `durationMs`. The auto-clear timer is
 * cancelled on unmount (see `useCancellableTimeout`, #2492).
 */
export function useFlashNotice(durationMs: number): {
  flash: FlashNotice | null;
  notify: (type: FlashNotice['type'], msg: string) => void;
} {
  const [flash, setFlash] = useState<FlashNotice | null>(null);
  const scheduleClear = useCancellableTimeout();

  const notify = useCallback((type: FlashNotice['type'], msg: string) => {
    setFlash({ type, msg });
    scheduleClear(() => setFlash(null), durationMs);
  }, [scheduleClear, durationMs]);

  return { flash, notify };
}
