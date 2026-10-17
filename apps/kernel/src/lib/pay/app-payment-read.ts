import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, transactions } from '@/src/db';
import { stripeByoRail } from './external-ref';

export const PAY_READ_SCOPE = 'pay:read';
export const MAX_PAYMENT_LOOKUP_SESSIONS = 100;

interface PaymentLookup {
  sellerDid: string;
  sessionIds: string[];
}

/** Validate before issuing SQL. App identity is never taken from the body. */
export function parsePaymentLookup(body: unknown): PaymentLookup | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { sellerDid, sessionIds } = body as Record<string, unknown>;
  if (typeof sellerDid !== 'string' || sellerDid.length > 500
    || !/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(sellerDid)) return null;
  if (!Array.isArray(sessionIds) || sessionIds.length < 1
    || sessionIds.length > MAX_PAYMENT_LOOKUP_SESSIONS
    || !sessionIds.every((id): id is string => typeof id === 'string'
      && id.length <= 255 && /^cs_[A-Za-z0-9_]+$/.test(id))) return null;
  return { sellerDid, sessionIds: [...new Set(sessionIds)] };
}

const ORDER_METADATA_KEYS = ['orderId', 'order_id', 'eventId', 'event_id', 'service', 'type'] as const;

/** Never serialize the open-ended payment metadata or nested provider objects. */
function safeOrderMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const metadata = value as Record<string, unknown>;
  return Object.fromEntries(ORDER_METADATA_KEYS.flatMap((key) => {
    const entry = metadata[key];
    return typeof entry === 'string' && entry.length <= 200 ? [[key, entry]] : [];
  }));
}

/** The WHERE clause is the ownership boundary, including seller account isolation. */
export async function readAppPayments(appDid: string, lookup: PaymentLookup) {
  const rows = await db.select({
    transactionId: transactions.id,
    sessionId: transactions.externalRef,
    metadata: transactions.metadata,
  }).from(transactions).where(and(
    eq(transactions.appDid, appDid),
    eq(transactions.toDid, lookup.sellerDid),
    inArray(transactions.externalRef, lookup.sessionIds),
    inArray(transactions.rail, ['stripe', stripeByoRail]),
  )).orderBy(asc(transactions.id));
  return rows.map((row) => ({
    transactionId: row.transactionId,
    sessionId: row.sessionId,
    metadata: safeOrderMetadata(row.metadata),
  }));
}
