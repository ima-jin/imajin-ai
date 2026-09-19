'use client';

import PaymentRequestRowItem from './PaymentRequestRowItem';
import type { PaymentRequestRow } from '../lib/types';

interface Props {
  requests: PaymentRequestRow[];
  loading: boolean;
  onChanged: () => void;
}

export default function PaymentRequestList({ requests, loading, onChanged }: Readonly<Props>) {
  if (loading) {
    return <div className="text-zinc-500 text-sm py-8 text-center">Loading…</div>;
  }

  if (requests.length === 0) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-10 text-center text-zinc-500">
        No payment requests yet
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {requests.map((row) => (
        <PaymentRequestRowItem key={row.id} row={row} onChanged={onChanged} />
      ))}
    </div>
  );
}
