import { and, eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, registryApps, transactions } from '@/src/db';
import { stripeRail, whereExternalRef } from './external-ref';
import type { StripeCheckoutSessionLike } from './webhook-event-shapes';

const log = createLogger('kernel');

/**
 * Only the app recorded on this rail/session may receive its paid notification.
 * Metadata and DID spellings are not registry identities. Unbound legacy rows,
 * revoked apps and failed lookups fail closed, including on the BYO rail.
 */
export async function checkoutAppSlug(session: StripeCheckoutSessionLike): Promise<string | undefined> {
  try {
    const [owner] = await db
      .select({ slug: registryApps.slug })
      .from(transactions)
      .innerJoin(registryApps, eq(transactions.appDid, registryApps.appDid))
      .where(and(
        whereExternalRef(session.id, session.rail ?? stripeRail),
        eq(registryApps.status, 'active'),
        ...(session.transactionId ? [eq(transactions.id, session.transactionId)] : []),
      ))
      .limit(1);
    if (owner?.slug) return owner.slug;
    log.warn({ sessionId: session.id }, 'Checkout has no registered originating app — notifications suppressed');
  } catch (error) {
    log.error({ sessionId: session.id, err: String(error) }, 'Checkout app lookup failed — notifications suppressed');
  }
  return undefined;
}
