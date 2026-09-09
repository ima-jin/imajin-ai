import { redirect } from 'next/navigation';
import { getSession , resolveActingDid } from '@imajin/auth';
import { db, transactions } from '@/src/db';
import { and, desc } from 'drizzle-orm';
import Link from 'next/link';
import TransactionList from './TransactionList';
import {
  type SearchParams,
  buildLoginRedirectTarget,
  parsePageNumber,
  buildTransactionConditions,
  buildFilterParams,
  hasActiveFilters,
  groupIntoDisplayEntries,
} from './helpers';

const SERVICE_ICONS: Record<string, string> = {
  coffee: '☕',
  emissions: '✨',
  events: '🎯',
  inference: '🤖',
  shop: '🛍',
  transfer: '↔',
  topup: '💳',
};

const PAGE_SIZE = 20;

export default async function HistoryPage(
  props: Readonly<{
    searchParams: Promise<SearchParams>;
  }>
) {
  const searchParams = await props.searchParams;
  const session = await getSession();

  if (!session) {
    redirect(buildLoginRedirectTarget());
  }

  const did = resolveActingDid(session);
  const { service, currency, from, to } = searchParams;
  const page = parsePageNumber(searchParams.page);
  const offset = (page - 1) * PAGE_SIZE;

  const { userTxCondition, conditions } = buildTransactionConditions(did, searchParams);

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

  const filterParams = buildFilterParams(searchParams);
  const hasFilters = hasActiveFilters(searchParams);
  const displayEntries = groupIntoDisplayEntries(txs);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/pay" className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
          ← Dashboard
        </Link>
        <h1 className="text-3xl font-bold text-white">Transaction History</h1>
      </div>

      <FilterForm service={service} currency={currency} from={from} to={to} services={services} hasFilters={hasFilters} />

      {/* Transaction list */}
      {displayEntries.length === 0 ? (
        <EmptyState hasFilters={hasFilters} />
      ) : (
        <TransactionList displayEntries={displayEntries} sessionId={did} />
      )}

      <PaginationControls page={page} hasMore={hasMore} filterParams={filterParams} />
    </div>
  );
}

function FilterForm({
  service,
  currency,
  from,
  to,
  services,
  hasFilters,
}: Readonly<{
  service: string | undefined;
  currency: string | undefined;
  from: string | undefined;
  to: string | undefined;
  services: string[];
  hasFilters: boolean;
}>) {
  return (
    <form
      method="GET"
      className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-wrap gap-3 items-end"
    >
      <div className="flex-1 min-w-[150px]">
        <label htmlFor="history-filter-service" className="block text-xs text-zinc-500 mb-1.5">Service</label>
        <select
          id="history-filter-service"
          name="service"
          defaultValue={service || ''}
          className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500 focus:outline-none"
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
        <label htmlFor="history-filter-currency" className="block text-xs text-zinc-500 mb-1.5">Currency</label>
        <select
          id="history-filter-currency"
          name="currency"
          defaultValue={currency || ''}
          className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500 focus:outline-none"
        >
          <option value="">All</option>
          <option value="Fiat">Fiat</option>
          <option value="MJN">人 MJN</option>
        </select>
      </div>

      <div className="flex-1 min-w-[140px]">
        <label htmlFor="history-filter-from" className="block text-xs text-zinc-500 mb-1.5">From</label>
        <input
          id="history-filter-from"
          type="date"
          name="from"
          defaultValue={from || ''}
          className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500 focus:outline-none"
        />
      </div>

      <div className="flex-1 min-w-[140px]">
        <label htmlFor="history-filter-to" className="block text-xs text-zinc-500 mb-1.5">To</label>
        <input
          id="history-filter-to"
          type="date"
          name="to"
          defaultValue={to || ''}
          className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500 focus:outline-none"
        />
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Filter
        </button>
        {hasFilters && (
          <Link
            href="/history"
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium rounded-lg transition-colors"
          >
            Clear
          </Link>
        )}
      </div>
    </form>
  );
}

function EmptyState({ hasFilters }: Readonly<{ hasFilters: boolean }>) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-12 text-center text-zinc-500">
      No transactions found
      {hasFilters && (
        <div className="mt-2">
          <Link href="/history" className="text-orange-500 hover:text-orange-400 text-sm">
            Clear filters
          </Link>
        </div>
      )}
    </div>
  );
}

function PaginationControls({
  page,
  hasMore,
  filterParams,
}: Readonly<{
  page: number;
  hasMore: boolean;
  filterParams: Record<string, string>;
}>) {
  if (!(page > 1 || hasMore)) return null;

  return (
    <div className="flex justify-between items-center">
      {page > 1 ? (
        <Link
          href={`/history?${new URLSearchParams({ ...filterParams, page: String(page - 1) })}`}
          className="px-4 py-2 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-sm rounded-lg transition-colors"
        >
          ← Previous
        </Link>
      ) : (
        <div />
      )}
      {hasMore && (
        <Link
          href={`/history?${new URLSearchParams({ ...filterParams, page: String(page + 1) })}`}
          className="px-4 py-2 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-sm rounded-lg transition-colors"
        >
          Next →
        </Link>
      )}
    </div>
  );
}
