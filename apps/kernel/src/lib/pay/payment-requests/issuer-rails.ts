/**
 * What an issuer can currently be paid through (#2754) — the answer behind the
 * issue-time warning on the new payment request form. Same two questions the
 * pay page asks at render time (`getPaymentRequestInvoiceByHandle`): a working
 * card rail (`resolveCardRail`) and a receiving e-Transfer email.
 */
import { eq } from 'drizzle-orm';
import { db, profiles } from '@/src/db';
import { resolveCardRail } from './card-rail';

export interface IssuerPayRails {
  /** A working card rail: the issuer's own Stripe connector (#2757: the only card rail). */
  card: boolean;
  /** The issuer has set an e-Transfer receiving email. */
  emt: boolean;
}

export async function getIssuerPayRails(issuerDid: string): Promise<IssuerPayRails> {
  const [rail, [profile]] = await Promise.all([
    resolveCardRail(issuerDid),
    db.select({ etransferEmail: profiles.etransferEmail }).from(profiles).where(eq(profiles.did, issuerDid)).limit(1),
  ]);
  return { card: rail.kind !== 'none', emt: Boolean(profile?.etransferEmail?.trim()) };
}
