/**
 * Pending-checkout bookkeeping for settlement (#2740).
 *
 * `POST /pay/api/settle` settles by `transaction_id` — the id the app-authenticated
 * checkout returned — and verifies the posted chain against the payee manifest
 * declared at that checkout. The purchase route therefore remembers, per Stripe
 * session, the transaction id plus the exact payee chain it declared; the
 * purchase webhook looks the entry up by session id and settles with it.
 *
 * Stored under `listings.metadata.pendingCheckouts[<sessionId>]` (a jsonb column,
 * so no migration). Every write is a single atomic SQL statement rather than a
 * read-modify-write, so two buyers purchasing the same listing at once cannot
 * clobber each other's entry. Entries older than a Stripe session's lifetime are
 * pruned on every new write, so abandoned checkouts do not accumulate.
 */
import { sql, eq } from 'drizzle-orm';
import { db, listings } from '@/db';

/** One settled payee — the shape `/pay/api/settle`'s `fair_manifest.chain` takes (dollars). */
export interface PayeeChainEntry {
  did: string;
  role: string;
  amount: number;
}

export interface PendingCheckout {
  /** `transactionId` returned by pay's `/api/checkout`. */
  transactionId: string;
  /** Gross payment in cents. */
  amountCents: number;
  /** The payee chain declared at checkout (dollars); settlement posts exactly this. */
  chain: PayeeChainEntry[];
  /** ISO timestamp the entry was recorded, used for pruning. */
  at: string;
}

/** Hosted Stripe Checkout sessions expire after 24h; keep entries for a day of slack on top. */
const PENDING_TTL_INTERVAL = '2 days';

/** Remember the checkout a Stripe session belongs to, pruning stale entries in the same statement. */
export async function recordPendingCheckout(
  listingId: string,
  sessionId: string,
  entry: Omit<PendingCheckout, 'at'>,
): Promise<void> {
  const stored: PendingCheckout = { ...entry, at: new Date().toISOString() };
  await db
    .update(listings)
    .set({
      metadata: sql`jsonb_set(
        coalesce(${listings.metadata}, '{}'::jsonb),
        '{pendingCheckouts}',
        (
          select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
          from jsonb_each(coalesce(${listings.metadata}->'pendingCheckouts', '{}'::jsonb)) as e
          where (e.value->>'at')::timestamptz > now() - ${PENDING_TTL_INTERVAL}::interval
        ) || jsonb_build_object(${sessionId}::text, ${JSON.stringify(stored)}::jsonb)
      )`,
    })
    .where(eq(listings.id, listingId));
}

function isChainEntry(value: unknown): value is PayeeChainEntry {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.did === 'string' && typeof row.role === 'string' && typeof row.amount === 'number';
}

/** Read (and shape-check) the pending checkout recorded for a Stripe session, or `null`. */
export function readPendingCheckout(metadata: unknown, sessionId: string): PendingCheckout | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const pending = (metadata as Record<string, unknown>).pendingCheckouts;
  if (pending === null || typeof pending !== 'object') return null;
  const entry = (pending as Record<string, unknown>)[sessionId];
  if (entry === null || typeof entry !== 'object') return null;

  const { transactionId, amountCents, chain, at } = entry as Record<string, unknown>;
  if (
    typeof transactionId !== 'string' ||
    transactionId.length === 0 ||
    typeof amountCents !== 'number' ||
    !Array.isArray(chain) ||
    chain.length === 0 ||
    !chain.every(isChainEntry)
  ) {
    return null;
  }
  return { transactionId, amountCents, chain, at: typeof at === 'string' ? at : '' };
}

/**
 * Store the settled `.fair` receipt on the listing and drop the now-settled pending
 * entry, atomically (`||` merges the receipt, `#-` deletes the entry).
 */
export async function saveSettlementSnapshot(listingId: string, sessionId: string, fairSettlement: unknown): Promise<void> {
  await db
    .update(listings)
    .set({
      metadata: sql`(
        coalesce(${listings.metadata}, '{}'::jsonb)
        || jsonb_build_object('fairSettlement', ${JSON.stringify(fairSettlement)}::jsonb)
      ) #- array['pendingCheckouts', ${sessionId}::text]`,
    })
    .where(eq(listings.id, listingId));
}
