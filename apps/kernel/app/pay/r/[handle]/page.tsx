import { notFound } from 'next/navigation';
import { getPaymentRequestByHandle } from '@/src/lib/pay/payment-requests/service';
import { formatMinorUnits } from '@/src/lib/pay/payment-requests/money-format';
import PayRequestActions from './PayRequestActions';

const STATUS_NOTES: Record<string, string> = {
  paid: 'This has already been paid.',
  settled_manual: 'This has already been settled.',
};

function StatusNote({ status }: Readonly<{ status: string }>) {
  if (status === 'issued') return null;
  return (
    <div className="text-sm text-center text-zinc-500 bg-black/30 border border-zinc-800 rounded-lg px-3 py-2">
      {STATUS_NOTES[status] ?? 'This payment request is no longer active.'}
    </div>
  );
}

/**
 * /pay/r/:handle — the public pay page for a payment_request's opaque
 * `pay_handle` (#2210/#2211). Unauthenticated, minimal, no PII: renders
 * exactly what `getPaymentRequestByHandle` returns (issuer display name,
 * line items, total, status) — nothing about the issuer's DID or the
 * recipient. `void` requests 404 the same as an unknown handle, matching
 * the underlying route's own behavior.
 */
export default async function PayByHandlePage({ params }: Readonly<{ params: Promise<{ handle: string }> }>) {
  const { handle } = await params;
  const view = await getPaymentRequestByHandle(handle);
  if (!view) {
    notFound();
  }

  return (
    <div className="max-w-lg mx-auto py-12 px-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-6">
        <div>
          <p className="text-xs text-zinc-500 uppercase tracking-wider">
            {view.kind === 'invoice' ? 'Invoice' : 'Payment request'} from
          </p>
          <h1 className="text-xl font-bold text-white mt-1">{view.issuerDisplayName}</h1>
        </div>

        <div className="space-y-1">
          {view.lineItems.map((item, i) => (
            <div key={`${item.name}-${i}`} className="flex justify-between text-sm text-zinc-300">
              <span>
                {item.name}
                {item.quantity > 1 ? ` × ${item.quantity}` : ''}
              </span>
              <span>{formatMinorUnits(item.amount * item.quantity, view.currency)}</span>
            </div>
          ))}
        </div>

        <div className="flex justify-between items-baseline border-t border-zinc-800 pt-4">
          <span className="text-sm text-zinc-400">Total due</span>
          <span className="text-2xl font-bold text-white">{formatMinorUnits(view.totalAmount, view.currency)}</span>
        </div>

        <StatusNote status={view.status} />

        <PayRequestActions handle={handle} status={view.status} />
      </div>
    </div>
  );
}
