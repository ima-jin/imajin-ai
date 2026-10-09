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
   * The issuer's display name — named in every "contact the issuer" message (#2754).
   */
  issuerName: string;
  /**
   * Whether a card payment can start for this request, resolved SERVER-SIDE at render time
   * (`card` on `getPaymentRequestInvoiceByHandle`, #2754): the issuer has a working card rail
   * and allows on-platform payment. `false` = no card button is rendered at all.
   */
  card: boolean;
  /**
   * The e-Transfer option (#2665). `null`/absent when the issuer has set no
   * receiving email (or e-Transfer can't carry this request) — then nothing
   * about e-Transfer renders.
   */
  emt?: EmtPayOption | null;
}

const ERROR_CLASSES = 'text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2';

/**
 * Messages for the stable `code` a failed checkout call carries (#2754). Every one names what is wrong
 * and who to ask — a card failure is never reduced to a generic "try again".
 */
const CHECKOUT_ERROR_BY_CODE: Readonly<Record<string, (issuer: string) => string>> = {
  SELLER_NO_CARD_RAIL: (issuer) => `${issuer} hasn't set up card payments yet. Contact ${issuer} to pay another way.`,
  CARD_RAIL_KEY_MISSING: (issuer) => `${issuer}'s Stripe connection isn't active, so card payment can't start. Contact ${issuer}.`,
  CARD_RAIL_KEY_REJECTED: (issuer) =>
    `Stripe rejected ${issuer}'s connection (the key was revoked or is missing a permission), so card payment can't start. Contact ${issuer}.`,
  CARD_RAIL_REQUEST_REJECTED: (issuer) =>
    `Stripe wouldn't start this payment — the amount or currency may not be supported on ${issuer}'s Stripe account. Contact ${issuer}.`,
  CARD_RAIL_UNAVAILABLE: () =>
    "Stripe isn't responding right now, so card payment couldn't start. You haven't been charged — wait a minute and press the button again.",
};

/** Messages for a checkout failure that carries no `code`, by HTTP status; `null` when the status alone says nothing specific. */
function checkoutErrorByStatus(status: number, issuer: string): string | null {
  switch (status) {
    case 401:
      return 'Sign in to pay by card — use the link below, and you will come straight back to this invoice.';
    case 403:
      return "You can't pay this request as the selected identity.";
    case 404:
      return "Online payment isn't available for this request yet.";
    case 409:
      return `This request can no longer be paid by card — it may already be paid or voided. Reload the page, or contact ${issuer}.`;
    default:
      return null;
  }
}

/** The inline message for a failed checkout call — specific to the code, else the status, else an honest server-side failure. */
export function checkoutErrorMessage(status: number, code: string | undefined, issuer: string): string {
  const byCode = code ? CHECKOUT_ERROR_BY_CODE[code] : undefined;
  if (byCode) return byCode(issuer);
  return (
    checkoutErrorByStatus(status, issuer) ??
    `Card payment couldn't be started because of a problem on our side (error ${status}). You haven't been charged — contact ${issuer} if this persists.`
  );
}

/** The `code` of an error response body, when it has one. */
async function errorCodeOf(res: Response): Promise<string | undefined> {
  try {
    const body = await res.json();
    return typeof body?.code === 'string' ? body.code : undefined;
  } catch {
    return undefined;
  }
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
interface EmtInstructionsProps {
  instructions: EmtInstructionsView;
  card: boolean;
  /** #2758: "Pay another way" — withdraw the e-Transfer choice. Only offered when there IS another way (card). */
  onLeave: () => void;
  leaving: boolean;
}

function EmtInstructions({ instructions, card, onLeave, leaving }: Readonly<EmtInstructionsProps>) {
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
        they can match it.{card ? ' You can still pay by card instead.' : ''}
      </p>
      {card && (
        <button
          type="button"
          onClick={onLeave}
          disabled={leaving}
          data-testid="emt-pay-another-way"
          className="text-xs text-zinc-400 hover:text-zinc-200 underline disabled:opacity-50 transition-colors"
        >
          {leaving ? 'Going back…' : 'Pay another way'}
        </button>
      )}
    </div>
  );
}

/** What the e-Transfer start call failed with, by status — specific, never a bare "try again". */
function emtErrorMessage(status: number, issuer: string): string {
  if (status === 404) return `e-Transfer isn't available for this request. Contact ${issuer}.`;
  if (status === 409) return `This request can no longer be paid — it may already be paid or voided. Reload the page, or contact ${issuer}.`;
  return `The e-Transfer details couldn't be loaded because of a problem on our side (error ${status}). Contact ${issuer} if this persists.`;
}

/** What leaving e-Transfer failed with (#2758), by status. A 409 means the issuer already confirmed a deposit — stay put and say so. */
function emtLeaveErrorMessage(status: number, issuer: string): string {
  if (status === 409) {
    return `${issuer} has already confirmed a payment on this request, so you can't switch. Reload the page to see its status.`;
  }
  if (status === 404) return `This request can't be found any more. Contact ${issuer}.`;
  return `We couldn't switch you off e-Transfer because of a problem on our side (error ${status}). Your e-Transfer details are still valid; contact ${issuer} if this persists.`;
}

const NETWORK_ERROR = "Couldn't reach the server — check your connection. You haven't been charged.";

/** Shown when the issuer has no working way to be paid online — not a dead button, a plain statement. */
function NothingToPay({ issuerName }: Readonly<{ issuerName: string }>) {
  return (
    <div
      data-testid="no-online-payment"
      className="text-sm text-center text-zinc-400 bg-black/30 border border-zinc-800 rounded-lg px-3 py-3"
    >
      This invoice can&apos;t be paid online yet. Contact {issuerName}.
    </div>
  );
}

/**
 * The pay actions for the public by-handle pay page (#2211) — only the rails that WORK (#2754):
 *   - `card` (resolved server-side) gates the card button;
 *   - `emt` gates the e-Transfer button;
 *   - neither renders {@link NothingToPay} and nothing else (no sign-in nudge: signing in cannot help).
 * Card checkout is `POST /pay/api/payment-requests/:handle/checkout`; every failure it can return is
 * turned into a message that says what is wrong and who to contact ({@link checkoutErrorMessage}).
 */
export default function PayRequestActions({ handle, status, issuerName, card, emt }: Readonly<Props>) {
  const pathname = usePathname();
  // #2656: a signed-in payer picks which of their DIDs pays; `paidByDid` is null (nothing sent) for an anonymous payer.
  const payerPicker = usePayerDids(handle);
  const { paidByDid } = payerPicker;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emtLoading, setEmtLoading] = useState(false);
  const [emtError, setEmtError] = useState<string | null>(null);
  const [emtLeaving, setEmtLeaving] = useState(false);
  const [emtInstructions, setEmtInstructions] = useState<EmtInstructionsView | null>(emt?.instructions ?? null);

  // `emt_pending` (#2665) is still payable — by card, or by completing the e-Transfer.
  if (status !== 'issued' && status !== 'emt_pending') {
    return null;
  }
  if (!card && !emt) {
    return <NothingToPay issuerName={issuerName} />;
  }

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
        setEmtError(emtErrorMessage(res.status, issuerName));
        return;
      }
      const data = await res.json();
      const instructions = data?.instructions;
      if (!instructions || typeof instructions.email !== 'string') {
        setEmtError(emtErrorMessage(502, issuerName));
        return;
      }
      setEmtInstructions({
        email: instructions.email,
        amountMinor: instructions.amountMinor,
        currency: instructions.currency,
        memo: instructions.memo,
      });
    } catch {
      setEmtError(NETWORK_ERROR);
    } finally {
      setEmtLoading(false);
    }
  }

  /** #2758: back out of e-Transfer — the server reverts `emt_pending -> issued`, so a refresh agrees with the page. */
  async function handleLeaveEmt() {
    setEmtLeaving(true);
    setEmtError(null);
    try {
      const res = await fetch(`/pay/api/payment-requests/by-handle/${encodeURIComponent(handle)}/emt`, { method: 'DELETE' });
      if (!res.ok) {
        setEmtError(emtLeaveErrorMessage(res.status, issuerName));
        return;
      }
      setEmtInstructions(null);
    } catch {
      setEmtError(NETWORK_ERROR);
    } finally {
      setEmtLeaving(false);
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
        setError(checkoutErrorMessage(res.status, await errorCodeOf(res), issuerName));
        return;
      }
      const data = await res.json();
      if (typeof data.url === 'string') {
        globalThis.location.href = data.url;
        return;
      }
      setError(checkoutErrorMessage(502, undefined, issuerName));
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <PayAsPicker picker={payerPicker} />

      {card && error && <div className={ERROR_CLASSES}>{error}</div>}

      {card && (
        <button
          type="button"
          onClick={handlePay}
          disabled={loading}
          className="w-full px-4 py-3 bg-amber-500 hover:bg-amber-400 disabled:bg-zinc-700 text-black font-semibold rounded-lg transition-colors"
        >
          {loading ? 'Starting checkout…' : cardLabel}
        </button>
      )}

      {emt && (
        <>
          {emtError && <div className={ERROR_CLASSES}>{emtError}</div>}
          {emtInstructions ? (
            <EmtInstructions instructions={emtInstructions} card={card} onLeave={handleLeaveEmt} leaving={emtLeaving} />
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
