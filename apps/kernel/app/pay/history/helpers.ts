// Pure helpers for the pay/history page (#2119: extracted so HistoryPage's
// cognitive complexity stays under the SonarCloud threshold — no behavior
// change). Kept out of page.tsx: Next.js's Page type validation rejects any
// named export from a page.tsx file other than the reserved ones (metadata,
// generateStaticParams, etc.) — "X is not a valid Page export field".
import { buildPublicUrl } from '@imajin/config';
import { transactions, type Transaction } from '@/src/db';
import { eq, or, gte, lte, inArray, type SQL } from 'drizzle-orm';
import type { DisplayEntry, SerializedTx } from './TransactionList';

export interface SearchParams {
  service?: string;
  currency?: string;
  from?: string;
  to?: string;
  page?: string;
}

// S4323: named once and reused everywhere below instead of repeating the
// same `Pick<...>` union inline in each function signature.
export type SearchFilterParams = Pick<SearchParams, 'service' | 'currency' | 'from' | 'to'>;

export function buildLoginRedirectTarget(): string {
  const authUrl = buildPublicUrl('auth');
  const payUrl = buildPublicUrl('pay');
  const historyUrl = `${payUrl}/history`;
  return `${authUrl}/login?next=${encodeURIComponent(historyUrl)}`;
}

export function parsePageNumber(rawPage: string | undefined): number {
  return Math.max(1, Number.parseInt(rawPage || '1'));
}

export function buildDateRangeEnd(to: string): Date {
  const toDate = new Date(to);
  toDate.setHours(23, 59, 59, 999);
  return toDate;
}

export function buildTransactionConditions(
  did: string,
  searchParams: SearchFilterParams,
): { userTxCondition: SQL; conditions: SQL[] } {
  const { service, currency, from, to } = searchParams;
  const userTxCondition = or(
    eq(transactions.fromDid, did),
    eq(transactions.toDid, did),
  )!;

  const conditions = [userTxCondition];
  if (service) conditions.push(eq(transactions.service, service));
  if (currency === 'MJN') conditions.push(eq(transactions.currency, 'MJN'));
  if (currency === 'Fiat') conditions.push(inArray(transactions.currency, ['CAD', 'USD', 'CHF', 'EUR', 'GBP']));
  if (from) conditions.push(gte(transactions.createdAt, new Date(from)));
  if (to) conditions.push(lte(transactions.createdAt, buildDateRangeEnd(to)));

  return { userTxCondition, conditions };
}

export function buildFilterParams(searchParams: SearchFilterParams): Record<string, string> {
  const { service, currency, from, to } = searchParams;
  return {
    ...(service ? { service } : {}),
    ...(currency ? { currency } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

export function hasActiveFilters(searchParams: SearchFilterParams): boolean {
  const { service, currency, from, to } = searchParams;
  return !!(service || currency || from || to);
}

export function serializeTransaction(tx: Transaction): SerializedTx {
  return {
    ...tx,
    amount: String(tx.amount),
    createdAt: tx.createdAt ? tx.createdAt.toISOString() : null,
  };
}

/**
 * Group transactions by batch_id; standalone entries (no batch_id) pass
 * through as-is. Preserves descending-date order: the batch group appears
 * at the position of its first member.
 */
export function groupIntoDisplayEntries(txs: Transaction[]): DisplayEntry[] {
  const batchMap = new Map<string, SerializedTx[]>();
  const displayEntries: DisplayEntry[] = [];

  for (const tx of txs) {
    const serialized = serializeTransaction(tx);

    if (tx.batchId) {
      if (!batchMap.has(tx.batchId)) {
        const entries: SerializedTx[] = [];
        batchMap.set(tx.batchId, entries);
        displayEntries.push({ kind: 'batch', batchId: tx.batchId, entries });
      }
      batchMap.get(tx.batchId)!.push(serialized);
    } else {
      displayEntries.push({ kind: 'standalone', tx: serialized });
    }
  }

  return displayEntries;
}
