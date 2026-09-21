'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@imajin/ui';
import CreatePaymentRequestForm from './CreatePaymentRequestForm';
import PaymentRequestList from './PaymentRequestList';
import type { PaymentRequestRow } from '../lib/types';

interface Props {
  issuerDid: string;
}

type StatusFilter = 'all' | 'issued' | 'paid' | 'settled_manual' | 'void';
type KindFilter = 'all' | 'invoice' | 'request';

const SELECT_CLASSES =
  'bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:border-amber-500 focus:outline-none';

/**
 * The Money tab (#2211): create/send/list/mark-settled/void
 * `pay.payment_request`s, scoped to the acting business identity. Talks
 * directly to the already-shipped routes under `/pay/api/payment-requests`
 * (#2207/#2208/#2210) — no new server code.
 */
export default function MoneyTab({ issuerDid }: Readonly<Props>) {
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [requests, setRequests] = useState<PaymentRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');

  const loadRequests = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ issuer_did: issuerDid });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (kindFilter !== 'all') params.set('kind', kindFilter);

      const res = await fetch(`/pay/api/payment-requests?${params.toString()}`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to load payment requests');
        return;
      }
      setRequests(data.paymentRequests ?? []);
    } catch {
      toast.error('Failed to load payment requests');
    } finally {
      setLoading(false);
    }
  }, [issuerDid, statusFilter, kindFilter, toast]);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  function handleCreated(row: PaymentRequestRow) {
    setCreating(false);
    setRequests((prev) => [row, ...prev]);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">Money</h2>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black text-sm font-medium rounded-lg transition-colors"
          >
            + New payment request
          </button>
        )}
      </div>

      {creating && (
        <CreatePaymentRequestForm issuerDid={issuerDid} onCreated={handleCreated} onCancel={() => setCreating(false)} />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div>
          <label htmlFor="money-status-filter" className="sr-only">
            Filter by status
          </label>
          <select
            id="money-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className={SELECT_CLASSES}
          >
            <option value="all">All statuses</option>
            <option value="issued">Issued</option>
            <option value="paid">Paid</option>
            <option value="settled_manual">Settled (manual)</option>
            <option value="void">Void</option>
          </select>
        </div>
        <div>
          <label htmlFor="money-kind-filter" className="sr-only">
            Filter by kind
          </label>
          <select
            id="money-kind-filter"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as KindFilter)}
            className={SELECT_CLASSES}
          >
            <option value="all">Invoices &amp; requests</option>
            <option value="invoice">Invoices</option>
            <option value="request">Requests</option>
          </select>
        </div>
      </div>

      <PaymentRequestList requests={requests} loading={loading} onChanged={loadRequests} />
    </div>
  );
}
