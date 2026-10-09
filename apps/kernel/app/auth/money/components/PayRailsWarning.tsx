'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

/** The two ways an issuer can be paid online (`GET /pay/api/payment-requests/rails`, #2754). */
interface PayRails {
  card: boolean;
  emt: boolean;
}

/**
 * Read which rails the issuer can be paid through. `null` when it can't be read
 * (network/auth/shape) — the warning stays hidden rather than guess: a false alarm
 * on every invoice would be worse than no warning.
 */
async function loadPayRails(issuerDid: string): Promise<PayRails | null> {
  try {
    const res = await fetch(`/pay/api/payment-requests/rails?issuer_did=${encodeURIComponent(issuerDid)}`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.card === 'boolean' && typeof data?.emt === 'boolean' ? { card: data.card, emt: data.emt } : null;
  } catch {
    return null;
  }
}

/**
 * Issue-time warning (#2754): shown on the new payment request form when the
 * issuer has neither a working card rail nor an e-Transfer receiving email —
 * the payer would open the invoice and find no way to pay it.
 */
export default function PayRailsWarning({ issuerDid }: Readonly<{ issuerDid: string }>) {
  const [rails, setRails] = useState<PayRails | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadPayRails(issuerDid)
      .then((loaded) => {
        if (!cancelled) setRails(loaded);
      })
      .catch(() => {
        // `loadPayRails` already answers `null` for every failure; this only keeps the promise handled.
        if (!cancelled) setRails(null);
      });
    return () => {
      cancelled = true;
    };
  }, [issuerDid]);

  if (!rails || rails.card || rails.emt) return null;

  return (
    <div
      role="alert"
      data-testid="no-pay-rails-warning"
      className="text-xs text-amber-300 bg-amber-900/20 border border-amber-700 rounded-lg px-3 py-2 space-y-1"
    >
      <p className="font-medium">Your payer won&apos;t be able to pay this online yet.</p>
      <p>
        You have no card payment set up and no e-Transfer email, so the invoice would say it can&apos;t be paid online.{' '}
        <Link href="/auth/connectors/stripe" className="underline hover:text-amber-200">
          Connect your Stripe key
        </Link>{' '}
        to take cards, or{' '}
        <Link href="/auth/tax" className="underline hover:text-amber-200">
          add an e-Transfer email
        </Link>
        , then send it.
      </p>
    </div>
  );
}
