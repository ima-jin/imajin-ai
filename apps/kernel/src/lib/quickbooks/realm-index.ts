/**
 * QuickBooks `realmId → { ownerDid, appDid }` reverse-lookup index (xprize #35).
 *
 * The connector-oauth factory seals `realmId` inside the owner's token bundle
 * (`quickbooks-oauth:${ownerDid}`) — readable forward (owner → realmId) only.
 * A webhook delivery from Intuit carries the opposite direction: it hands us a
 * `realmId` and we need to find which supplier DID (and which app's sealed
 * config) that company belongs to. This module is that index.
 *
 * `appDid` mirrors the `configDid` passed to `exchangeCodeAndStore` (#1704) —
 * the DID whose sealed `quickbooks-config:${appDid}` owns the Intuit client
 * credentials (and webhook verifier token) for this connection. It falls back
 * to `ownerDid` for the original BYO-app model, where the owner configures
 * their own app.
 */
import { eq, desc } from 'drizzle-orm';
import { db, quickbooksRealmIndex } from '@/src/db';

export interface QuickBooksRealmOwner {
  ownerDid: string;
  appDid: string;
}

/**
 * Upsert the `realmId → { ownerDid, appDid }` mapping. Called at
 * `exchangeCodeAndStore` time, where both values are already in hand.
 *
 * A supplier reconnecting — re-authorizing the same QBO company, or a new
 * one — always lands here: same `realmId` re-authorized overwrites the row in
 * place; a new `realmId` for the same DID inserts a fresh row.
 */
export async function upsertRealmIndex(realmId: string, ownerDid: string, appDid: string): Promise<void> {
  await db
    .insert(quickbooksRealmIndex)
    .values({ realmId, ownerDid, appDid })
    .onConflictDoUpdate({
      target: quickbooksRealmIndex.realmId,
      set: { ownerDid, appDid, updatedAt: new Date() },
    });
}

/** Resolve the `{ ownerDid, appDid }` pair a webhook's `realmId` belongs to, or undefined. */
export async function resolveRealmOwner(realmId: string): Promise<QuickBooksRealmOwner | undefined> {
  const [row] = await db
    .select({ ownerDid: quickbooksRealmIndex.ownerDid, appDid: quickbooksRealmIndex.appDid })
    .from(quickbooksRealmIndex)
    .where(eq(quickbooksRealmIndex.realmId, realmId))
    .limit(1);
  return row;
}

/**
 * Resolve the most recently connected `appDid` for an owner DID — the
 * `configDid` `settlePaidInvoices` should thread through for token refresh.
 * Used by the cron reconcile fallback, which enumerates owner DIDs from
 * `channel_links` and has no `realmId` in hand. Falls back to `ownerDid`
 * itself (BYO-app model) when no row is indexed yet.
 */
export async function resolveAppDidForOwner(ownerDid: string): Promise<string> {
  const [row] = await db
    .select({ appDid: quickbooksRealmIndex.appDid })
    .from(quickbooksRealmIndex)
    .where(eq(quickbooksRealmIndex.ownerDid, ownerDid))
    .orderBy(desc(quickbooksRealmIndex.updatedAt))
    .limit(1);
  return row?.appDid ?? ownerDid;
}
