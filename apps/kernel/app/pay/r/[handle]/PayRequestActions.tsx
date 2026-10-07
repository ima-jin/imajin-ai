'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { formatMinorUnits } from '@/src/lib/pay/payment-requests/money-format';
import type { EmtInstructionsView, EmtPayOption } from '@/src/lib/pay/payment-requests/emt-offer';
import PayAsPicker, { usePayerDids } from './PayAsPicker';

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
  /**
   * The e-Transfer option (#2665). `null`/absent when the issuer has set no
   * receiving email (or e-Transfer can't carry this request) — then nothing
   * about e-Transfer renders and the page is exactly the card-only page.
   */
  emt?: EmtPayOption | null;
}

const ERROR_CLASSES = 'text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2';

/** The inline message for a failed checkout call; a 403 is the server refusing the chosen "Pay as" identity (#2656). */
function checkoutErrorMessage(status: number): string {
  if (status === 404) return "Online payment isn't available for this request yet.";
  if (status === 403) return "You can't pay this request as the selected identity.";
  return 'Unable to start checkout. Please try again.';
}

function InstructionRow({ label, value, testId }: Readonly<{ label: string; value: string; testId: string }>) {
  return (
    <div className="flex justify-between gap-4" data-testid={testId}>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-zinc-100 text-right font-medium break-all select-all">{value}</dd>
    </div>
  );
}

/** Where to send the e-Transfer, the exact amount, and the memo that ties the deposit to this request (#2665). */
function EmtInstructions({ instructions }: Readonly<{ instructions: EmtInstructionsView }>) {
  return (
    <div className="space-y-3 bg-black/30 border border-zinc-800 rounded-lg px-4 py-3" data-testid="emt-instructions">
      <p className="text-sm text-zinc-300">Send an Interac e-Transfer with these exact details:</p>
      <dl className="space-y-1 text-sm">
        <InstructionRow label="Send to" value={instructions.email} testId="emt-email" />
        <InstructionRow label="Amount" value={formatMinorUnits(instructions.amountMinor, instructions.currency)} testId="emt-amount" />
        <InstructionRow label="Message / memo" value={instructions.memo} testId="emt-memo" />
      </dl>
      <p className="text-xs text-zinc-500">
        Payment is confirmed once the issuer sees your transfer arrive — you&apos;ll get a notification. Include the memo so
        they can match it. You can still pay by card instead.
      </p>
    </div>
  );
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
export default function PayRequestActions({ handle, status, allowOnPlatform, emt }: Readonly<Props>) {
  const pathname = usePathname();
  // #2656: a signed-in payer picks which of their DIDs pays; `paidByDid` is null (nothing sent) for an anonymous payer.
  const payerPicker = usePayerDids(handle);
  const { paidByDid } = payerPicker;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emtLoading, setEmtLoading] = useState(false);
  const [emtError, setEmtError] = useState<string | null>(null);
  const [emtInstructions, setEmtInstructions] = useState<EmtInstructionsView | null>(emt?.instructions ?? null);

  // `emt_pending` (#2665) is still payable — by card, or by completing the e-Transfer.
  if (status !== 'issued' && status !== 'emt_pending') {
    return null;
  }

  const isAllowed = allowOnPlatform !== false;
  // With e-Transfer on offer the choice is explicit; otherwise the page is unchanged.
  const cardLabel = emt ? 'Pay by card' : 'Pay now';
  const signInUrl = `/auth/login?next=${encodeURIComponent(pathname)}`;

  async function handleEmt() {
    setEmtLoading(true);
    setEmtError(null);
    try {
      const emtUrl = `/pay/api/payment-requests/by-handle/${encodeURIComponent(handle)}/emt`;
      const res = await fetch(
        emtUrl,
        paidByDid
          ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paidByDid }) }
          : { method: 'POST' },
      );
      if (!res.ok) {
        setEmtError('Unable to start the e-Transfer payment. Please try again.');
        return;
      }
      const data = await res.json();
      const instructions = data?.instructions;
      if (!instructions || typeof instructions.email !== 'string') {
        setEmtError('Unable to start the e-Transfer payment. Please try again.');
        return;
      }
      setEmtInstructions({
        email: instructions.email,
        amountMinor: instructions.amountMinor,
        currency: instructions.currency,
        memo: instructions.memo,
      });
    } catch {
      setEmtError('Unable to start the e-Transfer payment. Please try again.');
    } finally {
      setEmtLoading(false);
    }
  }

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
          ...(paidByDid ? { paidByDid } : {}),
        }),
      });
      if (!res.ok) {
        setError(checkoutErrorMessage(res.status));
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
      <PayAsPicker picker={payerPicker} />

      {error && <div className={ERROR_CLASSES}>{error}</div>}

      {isAllowed ? (
        <button
          type="button"
          onClick={handlePay}
          disabled={loading}
          className="w-full px-4 py-3 bg-amber-500 hover:bg-amber-400 disabled:bg-zinc-700 text-black font-semibold rounded-lg transition-colors"
        >
          {loading ? 'Starting checkout…' : cardLabel}
        </button>
      ) : (
        <div className="text-sm text-center text-zinc-500 bg-black/30 border border-zinc-800 rounded-lg px-3 py-2">
          Online payment isn&apos;t available for this request. Contact the issuer to pay directly.
        </div>
      )}

      {emt && (
        <>
          {emtError && <div className={ERROR_CLASSES}>{emtError}</div>}
          {emtInstructions ? (
            <EmtInstructions instructions={emtInstructions} />
          ) : (
            <button
              type="button"
              onClick={handleEmt}
              disabled={emtLoading}
              className="w-full px-4 py-3 bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-800/50 text-zinc-100 font-semibold rounded-lg transition-colors"
            >
              {emtLoading ? 'Preparing e-Transfer…' : 'Pay by e-Transfer'}
            </button>
          )}
        </>
      )}

      <a href={signInUrl} className="block text-center text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
        Already connected? Sign in to pay from your account
      </a>
    </div>
  );
}
