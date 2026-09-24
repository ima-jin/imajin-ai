'use client';

/**
 * Enable/disable phone push notifications for the /jin operator-approvals
 * queue (#2291). Renders nothing for a non-operator, an unsupported
 * browser, or while the initial check is still in flight — same
 * fail-invisible posture as `OperatorApprovalsPanel`.
 *
 * Flow: register the /jin-scoped service worker (`public/jin/sw.js`), ask
 * `GET /jin/api/push-subscriptions` for the VAPID public key, then use the
 * browser's `PushManager` to subscribe/unsubscribe — persisting the
 * resulting endpoint+keys via `POST`/`DELETE` on the same route.
 */
import { useCallback, useEffect, useState } from 'react';

const SW_URL = '/jin/sw.js';
const SW_SCOPE = '/jin/';

interface PushStatusResponse {
  isOperator: boolean;
  publicKey?: string | null;
}

/**
 * VAPID applicationServerKey must be a raw, `ArrayBuffer`-backed Uint8Array
 * (not `ArrayBufferLike`, which also covers `SharedArrayBuffer` and is what
 * a bare `Uint8Array` return type widens to under current DOM lib types) —
 * not the base64url string the server hands back.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replaceAll('-', '+').replaceAll('_', '/');
  const rawData = globalThis.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function pushSupported(): boolean {
  return 'serviceWorker' in globalThis.navigator && 'PushManager' in globalThis.window;
}

type SubscribeState = 'checking' | 'unsupported' | 'unsubscribed' | 'subscribed' | 'busy';

function labelFor(state: SubscribeState): string {
  if (state === 'busy') return '\u2026';
  if (state === 'subscribed') return 'Disable phone push';
  return 'Enable phone push';
}

export function PushSubscribeButton() {
  const [isOperator, setIsOperator] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [state, setState] = useState<SubscribeState>('checking');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function init(): Promise<void> {
      if (!pushSupported()) {
        setState('unsupported');
        return;
      }
      try {
        const res = await fetch('/jin/api/push-subscriptions', { credentials: 'include' });
        if (!res.ok) {
          setState('unsupported');
          return;
        }
        const data = (await res.json()) as PushStatusResponse;
        if (cancelled) return;
        setIsOperator(data.isOperator);
        if (!data.isOperator || !data.publicKey) {
          setState('unsupported');
          return;
        }
        setPublicKey(data.publicKey);

        const registration = await globalThis.navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
        const existing = await registration.pushManager.getSubscription();
        if (cancelled) return;
        setState(existing ? 'subscribed' : 'unsubscribed');
      } catch {
        if (!cancelled) setState('unsupported');
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  const subscribe = useCallback(async () => {
    if (!publicKey) return;
    setState('busy');
    setError(null);
    try {
      const registration = await globalThis.navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const json = subscription.toJSON();
      const res = await fetch('/jin/api/push-subscriptions', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      });
      if (!res.ok) throw new Error('subscribe save failed');
      setState('subscribed');
    } catch {
      setError('Could not enable phone notifications.');
      setState('unsubscribed');
    }
  }, [publicKey]);

  const unsubscribe = useCallback(async () => {
    setState('busy');
    setError(null);
    try {
      const registration = await globalThis.navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const { endpoint } = subscription;
        await subscription.unsubscribe();
        await fetch('/jin/api/push-subscriptions', {
          method: 'DELETE',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        });
      }
      setState('unsubscribed');
    } catch {
      setError('Could not disable phone notifications.');
      setState('subscribed');
    }
  }, []);

  if (!isOperator || state === 'checking' || state === 'unsupported') return null;

  const onClick = state === 'subscribed' ? unsubscribe : subscribe;

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-red-400">{error}</span>}
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={state === 'busy'}
        className="text-xs px-2.5 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {labelFor(state)}
      </button>
    </div>
  );
}
