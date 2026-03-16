import { redirect } from 'next/navigation';
import { getSession } from '@imajin/auth';
import { db, balances, transactions } from '@/src/db';
import { eq, or, desc } from 'drizzle-orm';
import Link from 'next/link';
import { BalanceCard } from './components/BalanceCard';
import { PayoutSetupBanner } from './components/PayoutSetupBanner';

const SERVICE_ICONS: Record<string, string> = {
  coffee: '☕',
  events: '🎟',
  inference: '🤖',
  shop: '🛍',
  transfer: '↔',
  topup: '💳',
};

export default async function Home() {
  const session = await getSession();

  if (!session) {
    const authUrl = process.env.NEXT_PUBLIC_AUTH_URL || 'https://auth.imajin.ai';
    const payUrl = process.env.NEXT_PUBLIC_PAY_URL || 'https://pay.imajin.ai';
    redirect(`${authUrl}/login?next=${encodeURIComponent(payUrl)}`);
  }

  const [balanceRows, recentTxs] = await Promise.all([
    db.select().from(balances).where(eq(balances.did, session.id)).limit(1),
    db
      .select()
      .from(transactions)
      .where(or(eq(transactions.fromDid, session.id), eq(transactions.toDid, session.id))!)
      .orderBy(desc(transactions.createdAt))
      .limit(5),
  ]);

  const balance = balanceRows[0];
  const cashAmount = balance ? parseFloat(balance.cashAmount) : 0;
  const creditAmount = balance ? parseFloat(balance.creditAmount) : 0;

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-white">Payment Dashboard</h1>
        <p className="text-zinc-400 mt-1">
          {session.handle ? `@${session.handle}` : session.name || session.id}
        </p>
      </div>

      {/* Payout Setup Banner */}
      <PayoutSetupBanner did={session.id} />

      {/* Balance */}
      <BalanceCard
        cashAmount={cashAmount}
        creditAmount={creditAmount}
        currency={balance?.currency || 'USD'}
        updatedAt={balance?.updatedAt ?? null}
      />

      {/* Quick Navigation */}
      <div className="flex gap-4">
        <Link
          href="/payouts"
          className="flex-1 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl p-4 text-center transition-colors group"
        >
          <div className="text-2xl mb-2">💰</div>
          <div className="text-sm font-medium text-white group-hover:text-orange-400 transition-colors">
            Payouts
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            Bank account & withdrawals
          </div>
        </Link>
        <Link
          href="/history"
          className="flex-1 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl p-4 text-center transition-colors group"
        >
          <div className="text-2xl mb-2">📊</div>
          <div className="text-sm font-medium text-white group-hover:text-orange-400 transition-colors">
            History
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            All transactions
          </div>
        </Link>
      </div>

      {/* Recent Transactions */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-white">Recent Transactions</h2>
          <Link href="/history" className="text-orange-500 hover:text-orange-400 text-sm transition-colors">
            View all →
          </Link>
        </div>

        {recentTxs.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 text-center text-zinc-500">
            No transactions yet
          </div>
        ) : (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl divide-y divide-zinc-800">
            {recentTxs.map((tx) => {
              const isIncoming = tx.toDid === session.id;
              const amount = parseFloat(tx.amount);
              const icon = SERVICE_ICONS[tx.service] || '💳';
              return (
                <div key={tx.id} className="px-5 py-4 flex items-center gap-4">
                  <span className="text-xl w-6 text-center shrink-0">{icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white capitalize">
                      {tx.type.replace(/_/g, ' ')}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {tx.service}
                      {tx.createdAt
                        ? ' · ' +
                          new Date(tx.createdAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })
                        : ''}
                    </div>
                  </div>
                  <div
                    className={`text-base font-semibold shrink-0 ${
                      isIncoming ? 'text-green-400' : 'text-red-400'
                    }`}
                  >
                    {isIncoming ? '+' : '-'}
                    {new Intl.NumberFormat('en-US', {
                      style: 'currency',
                      currency: tx.currency,
                    }).format(amount)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
