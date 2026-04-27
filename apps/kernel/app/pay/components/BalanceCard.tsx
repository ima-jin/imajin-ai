interface BalanceCardProps {
  cashAmount: number;
  creditAmount: number;
  currency?: string;
  updatedAt?: Date | null;
}

export function BalanceCard({ cashAmount, creditAmount, currency = 'USD', updatedAt }: BalanceCardProps) {
  const fmtCash = (n: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(n);

  return (
    <div className="bg-surface-base border border-white/10 p-6">
      <h2 className="text-xs font-medium text-muted uppercase tracking-wider mb-3 font-mono">Your Balance</h2>

      <div className="text-4xl font-bold text-primary mb-6">{fmtCash(cashAmount)}</div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-surface-base/40 border border-white/10 p-4">
          <div className="text-xs text-muted mb-1">Cash</div>
          <div className="text-xl font-semibold text-primary">{fmtCash(cashAmount)}</div>
          <div className="text-xs text-muted mt-1">Withdrawable</div>
        </div>
        <div className="bg-surface-base/40 border border-warning/40 p-4">
          <div className="text-xs text-warning mb-1">MJN</div>
          <div className="text-xl font-semibold text-warning">人{Math.round(creditAmount)}</div>
          <div className="text-xs text-muted mt-1">Earned through participation</div>
        </div>
      </div>

      {updatedAt && (
        <div className="text-xs text-muted mt-4">
          Updated {new Date(updatedAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}
