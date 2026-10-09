'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { loadPayRails } from '../lib/pay-rails';

/**
 * One-line migration nudge (#2757): card payments run on the seller's OWN Stripe
 * key now that Stripe Connect is gone, so a seller with no working card rail —
 * including anyone who used to take cards through Connect — is told where to
 * connect it. Shown only when the rail read succeeds and says there is no card
 * rail; an unreadable answer shows nothing.
 *
 * It asks the same question checkout asks (`resolveCardRail`, via the rails
 * endpoint) rather than reading the legacy `pay.connected_accounts` table, which
 * the app no longer reads or writes.
 */
export default function CardPaymentsNudge({ issuerDid }: Readonly<{ issuerDid: string }>) {
  const [noCardRail, setNoCardRail] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadPayRails(issuerDid)
      .then((rails) => {
        if (!cancelled) setNoCardRail(rails?.card === false);
      })
      .catch(() => {
        // `loadPayRails` already answers `null` for every failure; this only keeps the promise handled.
        if (!cancelled) setNoCardRail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [issuerDid]);

  if (!noCardRail) return null;

  return (
    <p
      role="status"
      data-testid="card-payments-nudge"
      className="text-sm text-amber-300 bg-amber-900/20 border border-amber-700 rounded-lg px-3 py-2"
    >
      Card payments now use your own Stripe key.{' '}
      <Link href="/auth/connectors/stripe" className="underline hover:text-amber-200">
        Connect it under Connectors.
      </Link>
    </p>
  );
}
