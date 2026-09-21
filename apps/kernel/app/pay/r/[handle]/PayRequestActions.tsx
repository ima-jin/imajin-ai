'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';

interface Props {
  handle: string;
  status: string;
  /**
   * Not present on today's `getPaymentRequestByHandle` response — that view
   * deliberately excludes it (see `service.ts`'s "no PII, nothing beyond
   * what's needed to pay" contract), and this PR makes no server changes.
   * Left optional so the UI is ready the moment the by-handle view grows
   * this field; until then it's always `undefined`, which this component
   * treats the same as `true` (allowed).
   */
  allowOnPlatform?: boolean;
}

/**
 * "Pay" button + "claim / sign in" path for the public by-handle pay page
 * (#2211). `POST /pay/api/payment-requests/:id/checkout` is #2215's job and
 * may not exist yet in this branch's stack — this degrades gracefully
 * (a 404/failure just surfaces as an inline message, never a crash).
 *
 * The checkout route is documented (#2209/#2215) as keyed by the internal
 * `id`, but the public pay page only ever has the opaque `payHandle` (by
 * design — see the by-handle route's doc comment). This substitutes the
 * handle for `:id`; if/when #2215 lands, it either accepts the handle here
 * too, or this call 404s and the graceful-degradation path below covers it.
 */
export default function PayRequestActions({ handle, status, allowOnPlatform }: Readonly<Props>) {
  const pathname = usePathname();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status !== 'issued') {
    return null;
  }

  const isAllowed = allowOnPlatform !== false;
  const signInUrl = `/auth/login?next=${encodeURIComponent(pathname)}`;

  async function handlePay() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/pay/api/payment-requests/${encodeURIComponent(handle)}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          successUrl: globalThis.location.href,
          cancelUrl: globalThis.location.href,
        }),
      });
      if (!res.ok) {
        setError(
          res.status === 404
            ? "Online payment isn't available for this request yet."
            : 'Unable to start checkout. Please try again.',
        );
        return;
      }
      const data = await res.json();
      if (typeof data.url === 'string') {
        globalThis.location.href = data.url;
        return;
      }
      setError('Unable to start checkout. Please try again.');
    } catch {
      setError('Unable to start checkout. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">{error}</div>}

      {isAllowed ? (
        <button
          type="button"
          onClick={handlePay}
          disabled={loading}
          className="w-full px-4 py-3 bg-amber-500 hover:bg-amber-400 disabled:bg-zinc-700 text-black font-semibold rounded-lg transition-colors"
        >
          {loading ? 'Starting checkout…' : 'Pay now'}
        </button>
      ) : (
        <div className="text-sm text-center text-zinc-500 bg-black/30 border border-zinc-800 rounded-lg px-3 py-2">
          Online payment isn&apos;t available for this request. Contact the issuer to pay directly.
        </div>
      )}

      <a href={signInUrl} className="block text-center text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
        Already connected? Sign in to pay from your account
      </a>
    </div>
  );
}
