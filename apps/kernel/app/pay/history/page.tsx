import { redirect } from 'next/navigation';
import { getSession } from '@imajin/auth';
import { db, transactions } from '@/src/db';
import { eq, and, or, desc, gte, lte, inArray } from 'drizzle-orm';
import Link from 'next/link';
import TransactionList, { type DisplayEntry, type SerializedTx } from './TransactionList';

const SERVICE_ICONS: Record<string, string> = {
  coffee: '☕',
  emissions: '✨',
  events: '🎟',
  inference: '🤖',
  shop: '🛍',
  transfer: '↔',
  topup: '💳',
};

const PAGE_SIZE = 20;

interface SearchParams {
  service?: string;
  currency?: string;
  from?: string;
  to?: string;
  page?: string;
}

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await getSession();

  if (!session) {
    const authUrl = process.env.NEXT_PUBLIC_AUTH_URL || 'https://auth.imajin.ai';
    const payUrl = process.env.NEXT_PUBLIC_PAY_URL || 'https://pay.imajin.ai';
    redirect(`${authUrl}/login?next=${encodeURIComponent(`${payUrl}/history`)}`);
  }

  const did = session.actingAs || session.id;
  const { service, currency, from, to } = searchParams;
  const page = Math.max(1, parseInt(searchParams.page || '1'));
  const offset = (page - 1) * PAGE_SIZE;

  const userTxCondition = or(
    eq(transactions.fromDid, did),
    eq(transactions.toDid, did),
  )!;

  const conditions = [userTxCondition];
  if (service) conditions.push(eq(transactions.service, service));
  if (currency === 'MJN') conditions.push(eq(transactions.currency, 'MJN'));
  if (currency === 'Fiat') conditions.push(inArray(transactions.currency, ['USD', 'CHF', 'EUR', 'GBP']));
  if (from) conditions.push(gte(transactions.createdAt, new Date(from)));
  if (to) {
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);
    conditions.push(lte(transactions.createdAt, toDate));
  }

  const [rows, serviceRows] = await Promise.all([
    db
      .select()
      .from(transactions)
      .where(and(...conditions))
      .orderBy(desc(transactions.createdAt))
      .limit(PAGE_SIZE + 1)
      .offset(offset),
    db
      .selectDistinct({ service: transactions.service })
      .from(transactions)
      .where(userTxCondition),
  ]);

  const hasMore = rows.length > PAGE_SIZE;
  const txs = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const services = serviceRows.map((r) => r.service).sort();

  const filterParams = {
    ...(service ? { service } : {}),
    ...(currency ? { currency } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };

  const hasFilters = service || currency || from || to;

  // Group transactions by batch_id; standalone entries (no batch_id) pass through as-is.
  // Preserve descending-date order: the batch group appears at the position of its first member.
  const batchMap = new Map<string, SerializedTx[]>();
  const displayEntries: DisplayEntry[] = [];

  // Single pass: serialize once, collect batches, and build display list
  for (const tx of txs) {
    const serialized: SerializedTx = {
      ...tx,
      amount: String(tx.amount),
      createdAt: tx.createdAt ? tx.createdAt.toISOString() : null,
    };

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

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/pay" className="text-muted hover:text-zinc-300 text-sm transition-colors">
          ← Dashboard
        </Link>
        <h1 className="text-3xl font-bold text-primary font-mono">Transaction History</h1>
      </div>

      {/* Filters */}
      <form
        method="GET"
        className="bg-surface-base border border-white/10 p-4 flex flex-wrap gap-3 items-end"
      >
        <div className="flex-1 min-w-[150px]">
          <label className="block text-xs text-muted mb-1.5">Service</label>
          <select
            name="service"
            defaultValue={service || ''}
            className="w-full bg-surface-base border border-white/10 px-3 py-2 text-sm text-primary focus:border-imajin-orange focus:outline-none"
          >
            <option value="">All services</option>
            {services.map((s) => (
              <option key={s} value={s}>
                {SERVICE_ICONS[s] || ''} {s}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 min-w-[120px]">
          <label className="block text-xs text-muted mb-1.5">Currency</label>
          <select
            name="currency"
            defaultValue={currency || ''}
            className="w-full bg-surface-base border border-white/10 px-3 py-2 text-sm text-primary focus:border-imajin-orange focus:outline-none"
          >
            <option value="">All</option>
            <option value="Fiat">Fiat</option>
            <option value="MJN">人 MJN</option>
          </select>
        </div>

        <div className="flex-1 min-w-[140px]">
          <label className="block text-xs text-muted mb-1.5">From</label>
          <input
            type="date"
            name="from"
            defaultValue={from || ''}
            className="w-full bg-surface-base border border-white/10 px-3 py-2 text-sm text-primary focus:border-imajin-orange focus:outline-none"
          />
        </div>

        <div className="flex-1 min-w-[140px]">
          <label className="block text-xs text-muted mb-1.5">To</label>
          <input
            type="date"
            name="to"
            defaultValue={to || ''}
            className="w-full bg-surface-base border border-white/10 px-3 py-2 text-sm text-primary focus:border-imajin-orange focus:outline-none"
          />
        </div>

        <div className="flex gap-2">
          <button
            type="submit"
            style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className="px-4 py-2 hover:brightness-110 text-primary text-sm font-medium transition-colors"
          >
            Filter
          </button>
          {hasFilters && (
            <Link
              href="/history"
              className="px-4 py-2 bg-surface-elevated hover:bg-surface-elevated text-zinc-300 text-sm font-medium transition-colors"
            >
              Clear
            </Link>
          )}
        </div>
      </form>

      {/* Transaction list */}
      {displayEntries.length === 0 ? (
        <div className="bg-surface-base border border-white/10 p-12 text-center text-muted">
          No transactions found
          {hasFilters && (
            <div className="mt-2">
              <Link href="/history" className="text-imajin-orange hover:text-imajin-orange text-sm">
                Clear filters
              </Link>
            </div>
          )}
        </div>
      ) : (
        <TransactionList displayEntries={displayEntries} sessionId={did} />
      )}

      {/* Pagination */}
      {(page > 1 || hasMore) && (
        <div className="flex justify-between items-center">
          {page > 1 ? (
            <Link
              href={`/history?${new URLSearchParams({ ...filterParams, page: String(page - 1) })}`}
              className="px-4 py-2 bg-surface-base border border-white/10 hover:border-white/10 text-zinc-300 text-sm transition-colors"
            >
              ← Previous
            </Link>
          ) : (
            <div />
          )}
          {hasMore && (
            <Link
              href={`/history?${new URLSearchParams({ ...filterParams, page: String(page + 1) })}`}
              className="px-4 py-2 bg-surface-base border border-white/10 hover:border-white/10 text-zinc-300 text-sm transition-colors"
            >
              Next →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
