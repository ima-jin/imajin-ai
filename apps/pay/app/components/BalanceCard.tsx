interface BalanceCardProps {
  cashAmount: number;
  creditAmount: number;
  currency?: string;
  updatedAt?: Date | null;
}

export function BalanceCard({ cashAmount, creditAmount, currency = 'USD', updatedAt }: BalanceCardProps) {
  const total = cashAmount + creditAmount;

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(n);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
      <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">Your Balance</h2>

      <div className="text-4xl font-bold text-white mb-6">{fmt(total)}</div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-black/40 border border-zinc-800 rounded-lg p-4">
          <div className="text-xs text-zinc-500 mb-1">Cash</div>
          <div className="text-xl font-semibold text-white">{fmt(cashAmount)}</div>
          <div className="text-xs text-zinc-600 mt-1">Withdrawable</div>
        </div>
        <div className="bg-black/40 border border-zinc-800 rounded-lg p-4">
          <div className="text-xs text-zinc-500 mb-1">Credits</div>
          <div className="text-xl font-semibold text-orange-400">{fmt(creditAmount)}</div>
          <div className="text-xs text-zinc-600 mt-1">Spend-only</div>
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
