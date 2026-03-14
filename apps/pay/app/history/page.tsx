import { redirect } from 'next/navigation';
import { getSession } from '@imajin/auth';
import { db, transactions } from '@/src/db';
import { eq, and, or, desc, gte, lte } from 'drizzle-orm';
import Link from 'next/link';

const SERVICE_ICONS: Record<string, string> = {
  coffee: '☕',
  events: '🎟',
  inference: '🤖',
  shop: '🛍',
  transfer: '↔',
  topup: '💳',
};

const PAGE_SIZE = 20;

interface SearchParams {
  service?: string;
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

  const { service, from, to } = searchParams;
  const page = Math.max(1, parseInt(searchParams.page || '1'));
  const offset = (page - 1) * PAGE_SIZE;

  const userTxCondition = or(
    eq(transactions.fromDid, session.id),
    eq(transactions.toDid, session.id),
  )!;

  const conditions = [userTxCondition];
  if (service) conditions.push(eq(transactions.service, service));
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
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };

  const hasFilters = service || from || to;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/" className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
          ← Dashboard
        </Link>
        <h1 className="text-3xl font-bold text-white">Transaction History</h1>
      </div>

      {/* Filters */}
      <form
        method="GET"
        className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-wrap gap-3 items-end"
      >
        <div className="flex-1 min-w-[150px]">
          <label className="block text-xs text-zinc-500 mb-1.5">Service</label>
          <select
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

        <div className="flex-1 min-w-[140px]">
          <label className="block text-xs text-zinc-500 mb-1.5">From</label>
          <input
            type="date"
            name="from"
            defaultValue={from || ''}
            className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500 focus:outline-none"
          />
        </div>

        <div className="flex-1 min-w-[140px]">
          <label className="block text-xs text-zinc-500 mb-1.5">To</label>
          <input
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

      {/* Transaction list */}
      {txs.length === 0 ? (
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
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl divide-y divide-zinc-800">
          {txs.map((tx) => {
            const isIncoming = tx.toDid === session.id;
            const amount = parseFloat(tx.amount);
            const icon = SERVICE_ICONS[tx.service] || '💳';
            const manifest = tx.fairManifest as {
              chain?: Array<{ did: string; amount: number; role: string }>;
            } | null;
            const hasChain = manifest?.chain && manifest.chain.length > 0;

            return (
              <details key={tx.id} className="group">
                <summary className="px-5 py-4 flex items-center gap-4 cursor-pointer hover:bg-zinc-800/40 transition-colors [list-style:none] [&::-webkit-details-marker]:hidden">
                  {/* Icon */}
                  <span className="text-xl w-7 text-center shrink-0">{icon}</span>

                  {/* Main info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-white capitalize">
                        {tx.type.replace(/_/g, ' ')}
                      </span>
                      <span className="text-xs px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded-full text-zinc-400">
                        {tx.service}
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border ${
                          tx.status === 'completed'
                            ? 'bg-green-900/30 text-green-400 border-green-800'
                            : tx.status === 'failed'
                              ? 'bg-red-900/30 text-red-400 border-red-800'
                              : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                        }`}
                      >
                        {tx.status}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {tx.createdAt
                        ? new Date(tx.createdAt).toLocaleString(undefined, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })
                        : ''}
                      {tx.batchId && (
                        <span className="ml-2 font-mono text-zinc-700">
                          {tx.batchId.slice(0, 16)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Amount + expand indicator */}
                  <div className="text-right shrink-0 flex items-center gap-3">
                    <div>
                      <div
                        className={`text-base font-semibold ${
                          isIncoming ? 'text-green-400' : 'text-red-400'
                        }`}
                      >
                        {isIncoming ? '+' : '-'}
                        {new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: tx.currency,
                        }).format(amount)}
                      </div>
                      <div className="text-xs text-zinc-600">{tx.source}</div>
                    </div>
                    {(hasChain || !!tx.metadata) && (
                      <svg
                        className="w-4 h-4 text-zinc-600 transition-transform group-open:rotate-180"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    )}
                  </div>
                </summary>

                {/* Expanded details */}
                <div className="px-5 pb-5 pl-16 space-y-3 border-t border-zinc-800/60">
                  <div className="pt-3 space-y-1.5">
                    <div className="text-xs text-zinc-500">
                      <span className="text-zinc-600 w-10 inline-block">From</span>
                      <span className="font-mono text-zinc-400 break-all">
                        {tx.fromDid || 'external'}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-500">
                      <span className="text-zinc-600 w-10 inline-block">To</span>
                      <span className="font-mono text-zinc-400 break-all">{tx.toDid}</span>
                    </div>
                  </div>

                  {/* .fair attribution chain */}
                  {hasChain && (
                    <div>
                      <div className="text-xs font-medium text-zinc-400 mb-2">
                        .fair attribution chain
                      </div>
                      <div className="space-y-1">
                        {manifest!.chain!.map((entry, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-3 text-xs bg-black/40 border border-zinc-800 rounded-lg px-3 py-2"
                          >
                            <span className="text-zinc-600 w-20 shrink-0">{entry.role}</span>
                            <span
                              className={`font-mono flex-1 truncate ${
                                entry.did === session.id ? 'text-orange-400' : 'text-zinc-400'
                              }`}
                            >
                              {entry.did}
                            </span>
                            <span
                              className={`font-medium shrink-0 ${
                                entry.did === session.id ? 'text-orange-400' : 'text-zinc-300'
                              }`}
                            >
                              {new Intl.NumberFormat('en-US', {
                                style: 'currency',
                                currency: tx.currency,
                              }).format(entry.amount)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Metadata */}
                  {tx.metadata && Object.keys(tx.metadata as object).length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-zinc-400 mb-2">Metadata</div>
                      <pre className="text-xs font-mono bg-black/40 border border-zinc-800 rounded-lg p-3 text-zinc-500 overflow-auto whitespace-pre-wrap">
                        {JSON.stringify(tx.metadata, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {(page > 1 || hasMore) && (
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
      )}
    </div>
  );
}
