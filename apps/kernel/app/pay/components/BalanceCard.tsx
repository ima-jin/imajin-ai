import Link from 'next/link';

/** One wallet unit's balance (#2016 — replaces the old cashAmount/creditAmount pair). */
export interface WalletBalance {
  unit: 'MJN' | 'MJNx';
  amount: number;
  withdrawable: boolean;
}

interface BalanceCardProps {
  balances: WalletBalance[];
  currency?: string;
  updatedAt?: Date | null;
}

export function BalanceCard({ balances, currency = 'CAD', updatedAt }: Readonly<BalanceCardProps>) {
  const mjn = balances.find((b) => b.unit === 'MJN')?.amount ?? 0;
  const mjnx = balances.find((b) => b.unit === 'MJNx')?.amount ?? 0;

  const fmtCash = (n: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(n);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Your Balance</h2>
        <Link
          href="/pay/topup"
          className="text-xs font-medium text-orange-500 hover:text-orange-400 transition-colors"
        >
          + Add Funds
        </Link>
      </div>

      <div className="text-4xl font-bold text-white mb-6">{fmtCash(mjn)}</div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-black/40 border border-zinc-800 rounded-lg p-4">
          <div className="text-xs text-zinc-500 mb-1">MJN</div>
          <div className="text-xl font-semibold text-white">{fmtCash(mjn)}</div>
          <div className="text-xs text-zinc-600 mt-1">Withdrawable</div>
        </div>
        <div className="bg-black/40 border border-amber-900/40 rounded-lg p-4">
          <div className="text-xs text-amber-600 mb-1">MJNx</div>
          <div className="text-xl font-semibold text-amber-400">人{Math.round(mjnx)}</div>
          <div className="text-xs text-zinc-600 mt-1">Earned in-platform · not withdrawable</div>
        </div>
      </div>

      {updatedAt && (
        <div className="text-xs text-zinc-600 mt-4">
          Updated {new Date(updatedAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}
