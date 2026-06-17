'use client';

import { useEffect, useRef } from 'react';

interface ErrorReport {
  message: string;
  stack: string;
  url: string;
  userAgent: string;
  componentStack?: string;
  timestamp: string;
}

interface QueuedError extends ErrorReport {
  fingerprint: string;
}

const FLUSH_INTERVAL_MS = 5000;
const DEDUP_WINDOW_MS = 60_000;
const MAX_QUEUE_SIZE = 10;
const MAX_SET_SIZE = 50;

function makeFingerprint(message: string, stack: string): string {
  const firstLine = stack.split('\n')[0] ?? '';
  return `${message}::${firstLine}`;
}

function sendErrors(errors: ErrorReport[]): void {
  if (errors.length === 0) return;

  const payload = JSON.stringify(errors);

  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    const success = navigator.sendBeacon('/api/client-errors', new Blob([payload], { type: 'application/json' }));
    if (success) return;
  }

  fetch('/api/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => {
    // Silently fail — never throw from the error reporter
  });
}

export function ClientErrorReporter(): null {
  const queueRef = useRef<QueuedError[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const lastSeenRef = useRef<Map<string, number>>(new Map());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    function flushQueue(): void {
      const queue = queueRef.current;
      if (queue.length === 0) return;
      queueRef.current = [];
      sendErrors(queue);
    }

    function enqueue(report: ErrorReport): void {
      try {
        const fingerprint = makeFingerprint(report.message, report.stack);
        const now = Date.now();
        const lastSeen = lastSeenRef.current.get(fingerprint);

        if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
          return;
        }

        const seen = seenRef.current;
        if (seen.size >= MAX_SET_SIZE) {
          const first = seen.values().next().value;
          if (first !== undefined) {
            seen.delete(first);
          }
        }
        seen.add(fingerprint);
        lastSeenRef.current.set(fingerprint, now);

        const queue = queueRef.current;
        queue.push({ ...report, fingerprint });

        if (queue.length >= MAX_QUEUE_SIZE) {
          flushQueue();
        }
      } catch {
        // Silently fail
      }
    }

    function handleError(event: ErrorEvent): void {
      try {
        enqueue({
          message: event.message || 'Unknown error',
          stack: event.error instanceof Error ? event.error.stack || '' : '',
          url: typeof globalThis.window === 'undefined' ? '' : globalThis.location.href,
          userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Silently fail
      }
    }

    function handleRejection(event: PromiseRejectionEvent): void {
      try {
        let message = 'Unhandled promise rejection';
        let stack = '';

        if (event.reason instanceof Error) {
          message = event.reason.message || message;
          stack = event.reason.stack || '';
        } else if (typeof event.reason === 'string') {
          message = event.reason;
        } else {
          try {
            message = JSON.stringify(event.reason);
          } catch {
            message = 'Unhandled promise rejection (non-serializable)';
          }
        }

        enqueue({
          message,
          stack,
          url: typeof globalThis.window === 'undefined' ? '' : globalThis.location.href,
          userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Silently fail
      }
    }

    function handleBeforeUnload(): void {
      flushQueue();
    }

    globalThis.addEventListener('error', handleError);
    globalThis.addEventListener('unhandledrejection', handleRejection);
    globalThis.addEventListener('beforeunload', handleBeforeUnload);

    timerRef.current = setInterval(flushQueue, FLUSH_INTERVAL_MS);

    return () => {
      globalThis.removeEventListener('error', handleError);
      globalThis.removeEventListener('unhandledrejection', handleRejection);
      globalThis.removeEventListener('beforeunload', handleBeforeUnload);

      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }

      flushQueue();
    };
  }, []);

  return null;
}
