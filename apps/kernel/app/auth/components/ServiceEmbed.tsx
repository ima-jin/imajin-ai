'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@imajin/ui';
import { buildEmbedSrc, getServiceBaseUrl, isKernelNativeService } from '../lib/service-registry';
import {
  isAppToKernelMessage,
  normalizeToastLevel,
  type AppToKernelMessage,
  type KernelToAppMessage,
} from '../lib/service-embed-protocol';
import { setServiceBadge } from '../lib/service-badge-bus';

interface Props {
  service: string;
  did: string;
}

type EmbedPhase = 'checking' | 'loading' | 'ready' | 'error';
type ErrorReason = 'unavailable' | 'timeout';

/** How long the iframe gets to fire `load` before we treat the embed as failed (#2275). */
const HANDSHAKE_TIMEOUT_MS = 10_000;

// There is no `onError` branch here: React only attaches a non-delegated
// 'error' listener for <img>/<link>/<source> (react-dom's setInitialProperties),
// not <iframe> — and real browsers don't reliably fire a native 'error' event
// for a cross-origin iframe load failure either (a 404/500 page still
// "succeeds" as a navigation from the iframe's own perspective). The health
// check below and the handshake timeout are the two signals that actually
// exist for this case.
const ERROR_COPY: Record<ErrorReason, string> = {
  unavailable: "This service isn't responding right now.",
  timeout: 'This service is taking too long to load.',
};

/** Origin the embedded app's postMessage traffic must come from/go to. */
function resolveExpectedOrigin(service: string): string | null {
  if (isKernelNativeService(service)) {
    return typeof globalThis.location === 'undefined' ? null : globalThis.location.origin;
  }
  const baseUrl = getServiceBaseUrl(service);
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

export default function ServiceEmbed({ service, did }: Readonly<Props>) {
  const [phase, setPhase] = useState<EmbedPhase>('checking');
  const [errorReason, setErrorReason] = useState<ErrorReason>('unavailable');
  const [attempt, setAttempt] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Plain (non-JSX) ref: React nulls out `iframeRef.current` before running
  // passive-effect cleanups on a full unmount, which would otherwise make the
  // `unload` send below a no-op right when it matters most.
  const targetWindowRef = useRef<Window | null>(null);
  const { toast } = useToast();

  const src = buildEmbedSrc(service, did);
  const expectedOrigin = resolveExpectedOrigin(service);

  const clearHandshakeTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  // Health check (#2275): catch a 4xx/5xx or unreachable service before ever
  // mounting the iframe, so the user sees a real error instead of a blank
  // frame or someone else's default error page rendered inside ours.
  useEffect(() => {
    let cancelled = false;
    setPhase('checking');
    setErrorReason('unavailable');

    async function check() {
      try {
        const res = await fetch(`/auth/api/services/health?service=${encodeURIComponent(service)}`, {
          credentials: 'include',
        });
        if (cancelled) return;
        if (!res.ok) {
          // The health route itself is broken — fail open rather than block
          // every embed on a bug in our own proxy.
          setPhase('loading');
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        if (data.ok === false) {
          setErrorReason('unavailable');
          setPhase('error');
          return;
        }
        setPhase('loading');
      } catch (err) {
        if (cancelled) return;
        console.error('[ServiceEmbed] health check failed, loading iframe anyway', err);
        setPhase('loading');
      }
    }

    check();
    return () => {
      cancelled = true;
    };
  }, [service, attempt]);

  // Handshake timeout: the iframe must fire `load` within the window, or we
  // treat the embed as failed rather than leaving a spinner up forever.
  useEffect(() => {
    if (phase !== 'loading') return undefined;
    timeoutRef.current = setTimeout(() => {
      setErrorReason('timeout');
      setPhase('error');
    }, HANDSHAKE_TIMEOUT_MS);
    return clearHandshakeTimeout;
  }, [phase, clearHandshakeTimeout]);

  const sendToApp = useCallback(
    (message: KernelToAppMessage) => {
      const win = targetWindowRef.current;
      if (!win || !expectedOrigin) return;
      win.postMessage(message, expectedOrigin);
    },
    [expectedOrigin],
  );

  const handleLoad = useCallback(() => {
    clearHandshakeTimeout();
    targetWindowRef.current = iframeRef.current?.contentWindow ?? null;
    setPhase('ready');
  }, [clearHandshakeTimeout]);

  // Kernel -> App (RFC-19): once the iframe is up, sync the current theme and
  // hand it a delegated session. Session minting is best-effort — an app that
  // isn't registered for token audiences yet (#1990) just keeps working off
  // the shared session cookie the iframe `src` already carries via `did=`.
  useEffect(() => {
    if (phase !== 'ready') return undefined;

    const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
    sendToApp({ type: 'theme', mode: isDark ? 'dark' : 'light' });

    if (isKernelNativeService(service) || !expectedOrigin) return undefined;

    let cancelled = false;
    const host = new URL(expectedOrigin).host;
    fetch('/auth/api/tokens/app', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aud: host }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.token) {
          sendToApp({ type: 'session', token: data.token });
        }
      })
      .catch((err) => {
        console.error('[ServiceEmbed] session token mint failed, app keeps using the session cookie', err);
      });

    return () => {
      cancelled = true;
    };
  }, [phase, sendToApp, expectedOrigin, service]);

  // App -> Kernel (RFC-19)
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!expectedOrigin || event.origin !== expectedOrigin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!isAppToKernelMessage(event.data)) return;

      const message: AppToKernelMessage = event.data;
      if (message.type === 'set_title') {
        document.title = `${message.title} · Imajin`;
      } else if (message.type === 'set_badge') {
        setServiceBadge(service, message.count);
      } else if (message.type === 'navigate') {
        if (message.path.startsWith('/')) {
          globalThis.history.replaceState(null, '', `/auth/${service}${message.path}`);
        }
      } else {
        toast[normalizeToastLevel(message.level)](message.message);
      }
    }

    globalThis.addEventListener('message', onMessage);
    return () => globalThis.removeEventListener('message', onMessage);
  }, [expectedOrigin, service, toast]);

  // Kernel -> App: tell the app it's being torn down (RFC-19 `unload`).
  useEffect(() => {
    return () => sendToApp({ type: 'unload' });
  }, [sendToApp]);

  if (phase === 'error') {
    return (
      <div className="w-full min-h-[600px] flex flex-col items-center justify-center gap-4 rounded-lg border border-zinc-800 bg-zinc-950 text-center p-8">
        <p className="text-zinc-300">{ERROR_COPY[errorReason]}</p>
        <button
          type="button"
          onClick={retry}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-amber-500 text-black hover:bg-amber-400 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="relative w-full min-h-[600px]">
      {phase !== 'ready' && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-zinc-950/60">
          <div
            role="status"
            aria-label={`Loading ${service}`}
            className="h-10 w-10 animate-spin rounded-full border-2 border-zinc-700 border-t-amber-500"
          />
        </div>
      )}
      {phase !== 'checking' && (
        <iframe
          key={attempt}
          ref={iframeRef}
          src={src}
          onLoad={handleLoad}
          className="w-full min-h-[600px] border-0 rounded-lg"
          allow="clipboard-write"
          title={`${service} dashboard`}
        />
      )}
    </div>
  );
}
