/**
 * `routingId → { ownerDid, endpointId }` lookup for the Stripe BYO-key
 * connector (#1785). See `db/schemas/stripe.ts` for why this index exists —
 * short version: a direct-account Stripe webhook delivery carries no
 * owner-identifying field, so the kernel mints its own routing id and embeds
 * it in the URL registered with Stripe.
 */
import { eq } from 'drizzle-orm';
import { db, stripeWebhookIndex } from '@/src/db';

export interface StripeWebhookOwner {
  ownerDid: string;
  endpointId: string;
}

/**
 * Upsert the `routingId → { ownerDid, endpointId }` mapping for this owner.
 *
 * One row per owner: a reconnect (key rotation) replaces the previous
 * routing id in place, so the superseded id can never resolve again — it is
 * simply absent from the table once this returns.
 */
export async function upsertWebhookIndex(
  routingId: string,
  ownerDid: string,
  endpointId: string,
): Promise<void> {
  await db
    .insert(stripeWebhookIndex)
    .values({ routingId, ownerDid, endpointId })
    .onConflictDoUpdate({
      target: stripeWebhookIndex.ownerDid,
      set: { routingId, endpointId, updatedAt: new Date() },
    });
}

/** Resolve the `{ ownerDid, endpointId }` a webhook delivery's routing id belongs to, or undefined. */
export async function resolveWebhookOwner(routingId: string): Promise<StripeWebhookOwner | undefined> {
  const [row] = await db
    .select({ ownerDid: stripeWebhookIndex.ownerDid, endpointId: stripeWebhookIndex.endpointId })
    .from(stripeWebhookIndex)
    .where(eq(stripeWebhookIndex.routingId, routingId))
    .limit(1);
  return row;
}

/** Find the current routing row for an owner (e.g. to deprovision on disconnect), or undefined. */
export async function findWebhookIndexByOwner(
  ownerDid: string,
): Promise<{ routingId: string; endpointId: string } | undefined> {
  const [row] = await db
    .select({ routingId: stripeWebhookIndex.routingId, endpointId: stripeWebhookIndex.endpointId })
    .from(stripeWebhookIndex)
    .where(eq(stripeWebhookIndex.ownerDid, ownerDid))
    .limit(1);
  return row;
}

/**
 * Remove an owner's routing row entirely (disconnect).
 *
 * Deleted rather than tombstoned, unlike the vault: this is plain routing
 * plumbing, not credential material, and a stale row left behind would keep
 * a disconnected owner's routing id resolvable to their DID for any future
 * (forged) delivery that happens to hit the old path.
 */
export async function deleteWebhookIndexByOwner(ownerDid: string): Promise<void> {
  await db.delete(stripeWebhookIndex).where(eq(stripeWebhookIndex.ownerDid, ownerDid));
}
